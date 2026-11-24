import assert from "node:assert/strict";
import test from "node:test";
import { createConnpassRequester } from "./connpass-api.mjs";

function createResponse(status, { retryAfter = null, body = { events: [], results_available: 0 } } = {}) {
    return {
        status,
        statusText: status === 200 ? "OK" : "Too Many Requests",
        ok: status >= 200 && status < 300,
        headers: {
            get: (name) => (name.toLowerCase() === "retry-after" ? retryAfter : null),
        },
        json: async () => body,
        text: async () => "",
    };
}

test("serializes concurrent Connpass requests at the API interval", async () => {
    let currentTime = 0;
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const requestTimes = [];
    const requester = createConnpassRequester("test-key", {
        now: () => currentTime,
        sleepImpl: async (ms) => {
            currentTime += ms;
        },
        fetchImpl: async () => {
            requestTimes.push(currentTime);
            activeRequests += 1;
            maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
            await Promise.resolve();
            activeRequests -= 1;
            return createResponse(200);
        },
    });

    await Promise.all([requester("first"), requester("second"), requester("third")]);

    assert.equal(maxActiveRequests, 1);
    assert.equal(requestTimes.length, 3);
    assert.ok(requestTimes[1] - requestTimes[0] >= 13000);
    assert.ok(requestTimes[2] - requestTimes[1] >= 13000);
});

test("honors Retry-After and retries a rate-limited Connpass request", async () => {
    let currentTime = 0;
    let requestCount = 0;
    const sleepDurations = [];
    const requester = createConnpassRequester("test-key", {
        now: () => currentTime,
        sleepImpl: async (ms) => {
            sleepDurations.push(ms);
            currentTime += ms;
        },
        fetchImpl: async () => {
            requestCount += 1;
            return requestCount === 1
                ? createResponse(429, { retryAfter: "3" })
                : createResponse(200);
        },
    });

    const result = await requester("events");

    assert.deepEqual(result, { events: [], results_available: 0 });
    assert.equal(requestCount, 2);
    assert.ok(sleepDurations.some((duration) => duration >= 13000));
});

test("does not repeatedly retry a 429 without Retry-After", async () => {
    let requestCount = 0;
    const requester = createConnpassRequester("test-key", {
        fetchImpl: async () => {
            requestCount += 1;
            return createResponse(429);
        },
    });

    await assert.rejects(requester("events"), /429/);
    assert.equal(requestCount, 1);
});

test("stops at the per-run request limit", async () => {
    let currentTime = 0;
    let requestCount = 0;
    const requester = createConnpassRequester("test-key", {
        now: () => currentTime,
        sleepImpl: async (ms) => { currentTime += ms; },
        fetchImpl: async () => {
            requestCount += 1;
            return createResponse(200);
        },
    });

    for (let index = 0; index < 80; index += 1) {
        await requester("events");
    }
    await assert.rejects(requester("events"), /limit for this run/);
    assert.equal(requestCount, 80);
});

test("continues queued requests after a failed request", async () => {
    let currentTime = 0;
    let requestCount = 0;
    const requester = createConnpassRequester("test-key", {
        now: () => currentTime,
        sleepImpl: async (ms) => {
            currentTime += ms;
        },
        fetchImpl: async () => {
            requestCount += 1;
            return createResponse(requestCount === 1 ? 500 : 200);
        },
    });

    const failedRequest = requester("fails");
    const nextRequest = requester("succeeds");

    await assert.rejects(failedRequest, /connpass API request failed: HTTP 500/);
    await assert.doesNotReject(nextRequest);
    assert.equal(requestCount, 2);
});
