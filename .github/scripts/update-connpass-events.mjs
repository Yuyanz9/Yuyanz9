import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const README_PATH = path.resolve(process.env.README_PATH ?? "README.md");
const FIXTURE_FILE = process.env.CONNPASS_FIXTURE_FILE?.trim();
const CONNPASS_API_KEY = process.env.CONNPASS_API_KEY?.trim();
const CONNPASS_NICKNAME = process.env.CONNPASS_NICKNAME?.trim();
const API_BASE_URL = "https://connpass.com/api/v2";
const API_PAGE_SIZE = 100;
const JST_TIME_ZONE = "Asia/Tokyo";
const API_REQUEST_INTERVAL_MS = 1100;

let lastRequestAt = 0;

async function main() {
    const readme = await readFile(README_PATH, "utf8");
    const { ownerEvents, presenterEvents } = FIXTURE_FILE
        ? await loadFixture(FIXTURE_FILE)
        : await fetchConnpassEvents();

    const events = mergeEvents(ownerEvents, presenterEvents);
    const { upcomingEvents, archivedEvents } = splitEvents(events, new Date());

    const updatedReadme = replaceSection(
        replaceSection(readme, "CONNPASS-UPCOMING", renderTable(upcomingEvents, "No upcoming connpass events found.")),
        "CONNPASS-ARCHIVE",
        renderTable(archivedEvents, "No archived connpass events found."),
    );

    if (updatedReadme === readme) {
        console.log("README is already up to date.");
        return;
    }

    await writeFile(README_PATH, updatedReadme, "utf8");
    console.log(
        `Updated ${path.relative(process.cwd(), README_PATH)} with ${upcomingEvents.length} upcoming and ${archivedEvents.length} archived connpass events.`,
    );
}

async function loadFixture(filePath) {
    const fixturePath = path.resolve(filePath);
    const rawFixture = await readFile(fixturePath, "utf8");
    const parsedFixture = JSON.parse(rawFixture);

    return {
        ownerEvents: Array.isArray(parsedFixture.ownerEvents) ? parsedFixture.ownerEvents : [],
        presenterEvents: Array.isArray(parsedFixture.presenterEvents) ? parsedFixture.presenterEvents : [],
    };
}

async function fetchConnpassEvents() {
    if (!CONNPASS_API_KEY) {
        throw new Error("Missing CONNPASS_API_KEY. Configure it as a GitHub Actions secret before running this script.");
    }

    if (!CONNPASS_NICKNAME) {
        throw new Error("Missing CONNPASS_NICKNAME. Set it in the workflow env or repository variables.");
    }

    const ownerEvents = await fetchPaginatedEvents((start) => {
        const searchParams = new URLSearchParams({
            owner_nickname: CONNPASS_NICKNAME,
            order: "2",
            start: String(start),
            count: String(API_PAGE_SIZE),
        });

        return `${API_BASE_URL}/events/?${searchParams.toString()}`;
    });

    const presenterEvents = await fetchPaginatedEvents((start) => {
        const searchParams = new URLSearchParams({
            start: String(start),
            count: String(API_PAGE_SIZE),
        });

        return `${API_BASE_URL}/users/${encodeURIComponent(CONNPASS_NICKNAME)}/presenter_events/?${searchParams.toString()}`;
    });

    return { ownerEvents, presenterEvents };
}

async function fetchPaginatedEvents(buildUrl) {
    const events = [];
    let start = 1;

    while (true) {
        const payload = await requestConnpassJson(buildUrl(start));
        const pageEvents = Array.isArray(payload.events) ? payload.events : [];
        events.push(...pageEvents);

        if (pageEvents.length < API_PAGE_SIZE || events.length >= Number(payload.results_available ?? 0)) {
            break;
        }

        start += API_PAGE_SIZE;
    }

    return events;
}

async function requestConnpassJson(url, retryCount = 0) {
    const now = Date.now();
    const waitMs = Math.max(0, API_REQUEST_INTERVAL_MS - (now - lastRequestAt));

    if (waitMs > 0) {
        await sleep(waitMs);
    }

    const response = await fetch(url, {
        headers: {
            "User-Agent": "Yuyanz9-README-Connpass-Sync",
            "X-API-Key": CONNPASS_API_KEY,
        },
    });

    lastRequestAt = Date.now();

    if (response.status === 429 && retryCount < 2) {
        await sleep(API_REQUEST_INTERVAL_MS * (retryCount + 1));
        return requestConnpassJson(url, retryCount + 1);
    }

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`connpass API request failed: ${response.status} ${response.statusText} ${errorText}`.trim());
    }

    return response.json();
}

function mergeEvents(ownerEvents, presenterEvents) {
    const mergedEvents = new Map();

    for (const event of [...ownerEvents, ...presenterEvents]) {
        if (!event || !event.id || !event.title || !event.url || !event.started_at) {
            continue;
        }

        const community = resolveCommunity(event);
        const normalizedEvent = {
            id: Number(event.id),
            title: String(event.title).trim(),
            url: String(event.url),
            startedAt: String(event.started_at),
            updatedAt: String(event.updated_at ?? event.started_at),
            communityTitle: community.title,
            communityUrl: community.url,
        };

        const existingEvent = mergedEvents.get(normalizedEvent.id);
        if (!existingEvent || new Date(normalizedEvent.updatedAt) > new Date(existingEvent.updatedAt)) {
            mergedEvents.set(normalizedEvent.id, normalizedEvent);
        }
    }

    return Array.from(mergedEvents.values());
}

function resolveCommunity(event) {
    const groupTitle = typeof event.group?.title === "string" ? event.group.title.trim() : "";
    const groupUrl = typeof event.group?.url === "string" ? event.group.url : "";

    if (groupTitle) {
        return {
            title: groupTitle,
            url: groupUrl || fallbackCommunityUrl(event.url),
        };
    }

    try {
        const eventUrl = new URL(String(event.url));
        return {
            title: eventUrl.hostname.split(".")[0],
            url: `${eventUrl.protocol}//${eventUrl.hostname}/`,
        };
    } catch {
        return {
            title: "-",
            url: "",
        };
    }
}

function fallbackCommunityUrl(eventUrl) {
    try {
        const parsedUrl = new URL(String(eventUrl));
        return `${parsedUrl.protocol}//${parsedUrl.hostname}/`;
    } catch {
        return "";
    }
}

function splitEvents(events, now) {
    const upcomingEvents = [];
    const archivedEvents = [];

    for (const event of events) {
        if (new Date(event.startedAt) >= now) {
            upcomingEvents.push(event);
            continue;
        }

        archivedEvents.push(event);
    }

    upcomingEvents.sort((left, right) => new Date(left.startedAt) - new Date(right.startedAt));
    archivedEvents.sort((left, right) => new Date(right.startedAt) - new Date(left.startedAt));

    return { upcomingEvents, archivedEvents };
}

function renderTable(events, emptyMessage) {
    if (!events.length) {
        return emptyMessage;
    }

    const header = [
        "| Date | Event | Community |",
        "|------|-------|-----------|",
    ];

    const rows = events.map((event) => {
        const eventTitle = escapeLinkText(event.title);
        const communityTitle = escapeLinkText(event.communityTitle || "-");
        const communityCell = event.communityUrl ? `[${communityTitle}](${event.communityUrl})` : communityTitle;
        return `| ${formatDateInJst(event.startedAt)} | [${eventTitle}](${event.url}) | ${communityCell} |`;
    });

    return [...header, ...rows].join("\n");
}

function replaceSection(content, tagName, replacement) {
    const markerPattern = new RegExp(`<!-- ${tagName}:START -->([\\s\\S]*?)<!-- ${tagName}:END -->`);

    if (!markerPattern.test(content)) {
        throw new Error(`Missing README marker for ${tagName}.`);
    }

    return content.replace(markerPattern, `<!-- ${tagName}:START -->\n${replacement}\n<!-- ${tagName}:END -->`);
}

function formatDateInJst(value) {
    return new Intl.DateTimeFormat("en-CA", {
        day: "2-digit",
        month: "2-digit",
        timeZone: JST_TIME_ZONE,
        year: "numeric",
    }).format(new Date(value));
}

function escapeLinkText(value) {
    return String(value)
        .replace(/\[/g, "&#91;")
        .replace(/\]/g, "&#93;")
        .replace(/\|/g, "\\|")
        .replace(/\r?\n/g, " ")
        .trim();
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});