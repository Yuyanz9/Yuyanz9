const API_REQUEST_INTERVAL_MS = 13000;
const MAX_REQUESTS_PER_RUN = 80;
const MAX_RETRY_WAIT_MS = 60000;

export class ConnpassRequestError extends Error {}

export function createConnpassRequester(apiKey, {
    fetchImpl = fetch,
    sleepImpl = sleep,
    now = Date.now,
} = {}) {
    let lastRequestAt = null;
    let requestCount = 0;
    let requestQueue = Promise.resolve();

    return function requestConnpassJson(url) {
        const request = requestQueue.then(async () => {
            for (let retryCount = 0; ; retryCount += 1) {
                if (requestCount >= MAX_REQUESTS_PER_RUN) {
                    throw new ConnpassRequestError(`connpass API request limit for this run reached (${MAX_REQUESTS_PER_RUN}).`);
                }

                const waitMs = lastRequestAt === null ? 0 : Math.max(0, API_REQUEST_INTERVAL_MS - (now() - lastRequestAt));

                if (waitMs > 0) {
                    await sleepImpl(waitMs);
                }

                let response;
                lastRequestAt = now();
                requestCount += 1;
                try {
                    response = await fetchImpl(url, {
                        headers: {
                            "User-Agent": "Yuyanz9-README-Connpass-Sync",
                            "X-API-Key": apiKey,
                        },
                    });
                } catch (error) {
                    throw new ConnpassRequestError(`connpass API request failed: ${error.message}`, { cause: error });
                }

                if (response.status === 429 && retryCount === 0) {
                    const retryAfterMs = parseRetryAfter(response.headers?.get("Retry-After"), now());
                    if (retryAfterMs !== null && retryAfterMs <= MAX_RETRY_WAIT_MS) {
                        await sleepImpl(Math.max(API_REQUEST_INTERVAL_MS, retryAfterMs));
                        continue;
                    }
                }

                if (!response.ok) {
                    throw new ConnpassRequestError(
                        `connpass API request failed: HTTP ${response.status}.`,
                    );
                }

                let payload;
                try {
                    payload = await response.json();
                } catch (error) {
                    throw new ConnpassRequestError("connpass API returned invalid JSON.", { cause: error });
                }
                if (!Array.isArray(payload?.events) || !Number.isInteger(payload.results_available) || payload.results_available < 0) {
                    throw new ConnpassRequestError("connpass API returned an invalid events response.");
                }
                return payload;
            }
        });

        requestQueue = request.catch(() => {});
        return request;
    };
}

function parseRetryAfter(value, now) {
    if (!value) {
        return null;
    }

    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
        return Math.max(0, seconds * 1000);
    }

    const retryAt = Date.parse(value);
    return Number.isNaN(retryAt) ? null : Math.max(0, retryAt - now);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
