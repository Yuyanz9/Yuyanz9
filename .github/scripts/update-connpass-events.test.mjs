import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const script = path.join(root, ".github", "scripts", "update-connpass-events.mjs");
const mock = path.join(root, ".github", "scripts", "fixtures", "mock-connpass-fetch.mjs");
const docswell = path.join(root, ".github", "scripts", "fixtures", "docswell-sample-feed.xml");

async function runSync(failure, { manyEvents = false } = {}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "readme-sync-test-"));
    try {
        const readme = path.join(dir, "README.md");
        const qiita = path.join(dir, "qiita.xml");
        const output = path.join(dir, "output.txt");
        const requestLog = path.join(dir, "requests.txt");
        const feed = path.join(dir, "docswell.xml");
        await writeFile(readme, [
            "<!-- ABOUT-ME-STATS:START -->",
            "- ✍️ 記事数: **9**",
            "- 🎤 登壇数（登壇資料数）: **9**",
            "- 🤝 イベント運営数: **53**",
            "<!-- ABOUT-ME-STATS:END -->",
            "<!-- BLOG-POST-LIST:START -->",
            "Old post",
            "<!-- BLOG-POST-LIST:END -->",
            "<!-- CONNPASS-UPCOMING:START -->",
            "| Date | Event | Community |",
            "|------|-------|-----------|",
            "| 2099-01-01 | [Existing event](https://old.connpass.com/event/999/) | [Old](https://old.connpass.com/) |",
            "<!-- CONNPASS-UPCOMING:END -->",
            "<!-- CONNPASS-ARCHIVE:START -->",
            "No archived connpass events found.",
            "<!-- CONNPASS-ARCHIVE:END -->",
        ].join("\n"));
        await writeFile(qiita, "<rss><item><title>New post</title><link>https://qiita.com/test/items/1</link></item></rss>");
        if (manyEvents) {
            const links = Array.from({ length: 105 }, (_, index) => `https://example.connpass.com/event/${10000 + index}/`).join(" ");
            await writeFile(feed, `<rss><item><title>Slides</title><link>https://docswell.com/s/test/slides</link><description>${links}</description></item></rss>`);
        }
        const result = spawnSync(process.execPath, ["--import", pathToFileURL(mock).href, script], {
            cwd: root,
            encoding: "utf8",
            env: {
                ...process.env,
                README_PATH: readme,
                QIITA_FEED_FILE: qiita,
                DOCSWELL_FEED_FILE: manyEvents ? feed : docswell,
                CONNPASS_API_KEY: "test-key",
                CONNPASS_MANAGED_SUBDOMAIN: "yonayona",
                CONNPASS_FIXTURE_FILE: "",
                GITHUB_OUTPUT: output,
                MOCK_CONNPASS_FAILURE: String(failure),
                MOCK_GENERATED_EVENTS: String(manyEvents),
                MOCK_REQUEST_LOG: requestLog,
            },
        });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        return {
            result,
            readme: await readFile(readme, "utf8"),
            output: await readFile(output, "utf8"),
            requests: (await readFile(requestLog, "utf8")).trim().split("\n").map((query) => new URLSearchParams(query)),
        };
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

test("updates events via the API without fetching Connpass web pages", async () => {
    const { result, readme, output } = await runSync(false);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readme, /Future owner event/);
    assert.match(readme, /Past presenter event/);
    assert.match(readme, /Existing event/);
    assert.match(readme, /イベント運営数: \*\*53\*\*/u);
    assert.match(output, /connpass_failed=false/);
});

test("batches more than 100 Docswell event IDs without losing results", async () => {
    const { readme, requests } = await runSync(false, { manyEvents: true });
    const batches = requests.filter((request) => request.has("event_id"));
    assert.deepEqual(batches.map((request) => request.get("event_id").split(",").length), [100, 5]);
    assert.match(readme, /Event 10000/);
    assert.match(readme, /Event 10104/);
});

test("preserves events and reports Connpass failure while updating other data", async () => {
    const { result, readme, output } = await runSync(true);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Connpass sync skipped.*429/);
    assert.match(readme, /Existing event/);
    assert.match(readme, /New post/);
    assert.match(readme, /登壇資料数）: \*\*2\*\*/u);
    assert.match(readme, /イベント運営数: \*\*53\*\*/u);
    assert.match(output, /connpass_failed=true/);
});

test("discards partial Connpass data if a later request fails", async () => {
    const { readme, output, requests } = await runSync("batch");
    assert.equal(requests.length, 2);
    assert.match(readme, /Existing event/);
    assert.doesNotMatch(readme, /Future owner event/);
    assert.match(output, /connpass_failed=true/);
});
