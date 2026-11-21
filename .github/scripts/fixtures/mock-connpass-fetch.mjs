import { appendFile, readFile } from "node:fs/promises";

let time = 0;
Date.now = () => (time += 13000);
const fixture = JSON.parse(await readFile(".github/scripts/fixtures/connpass-sample.json", "utf8"));

globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.origin !== "https://connpass.com" || url.pathname !== "/api/v2/events/") {
        throw new Error(`Unexpected network request: ${url}`);
    }
    if (process.env.MOCK_REQUEST_LOG) {
        await appendFile(process.env.MOCK_REQUEST_LOG, `${url.search}\n`);
    }
    if (process.env.MOCK_CONNPASS_FAILURE === "true" ||
        (process.env.MOCK_CONNPASS_FAILURE === "batch" && url.searchParams.has("event_id"))) {
        return new Response('{"detail":"Too many requests."}', { status: 429 });
    }
    const ids = url.searchParams.get("event_id");
    const events = ids && process.env.MOCK_GENERATED_EVENTS === "true"
        ? ids.split(",").map((id) => ({
            id: Number(id),
            title: `Event ${id}`,
            url: `https://example.connpass.com/event/${id}/`,
            started_at: "2099-01-01T10:00:00+09:00",
        }))
        : ids
        ? fixture.presenterEvents.filter((event) => ids.split(",").includes(String(event.id)))
        : fixture.ownerEvents;
    return Response.json({ events, results_available: events.length });
};
