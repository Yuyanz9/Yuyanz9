import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const README_PATH = path.resolve(process.env.README_PATH ?? "README.md");
const FIXTURE_FILE = process.env.CONNPASS_FIXTURE_FILE?.trim();
const DOCSWELL_FEED_FILE = process.env.DOCSWELL_FEED_FILE?.trim();
const QIITA_FEED_FILE = process.env.QIITA_FEED_FILE?.trim();
const CONNPASS_API_KEY = process.env.CONNPASS_API_KEY?.trim();
const CONNPASS_NICKNAME = process.env.CONNPASS_NICKNAME?.trim();
const MAX_QIITA_POSTS = Number.parseInt(process.env.MAX_QIITA_POSTS ?? "5", 10);
const API_BASE_URL = "https://connpass.com/api/v2";
const API_PAGE_SIZE = 100;
const API_EVENT_ID_BATCH_SIZE = 50;
const JST_TIME_ZONE = "Asia/Tokyo";
const API_REQUEST_INTERVAL_MS = 1100;
const DOCSWELL_MATCH_WINDOW_DAYS = 7;
const MATERIAL_LINK_LABEL = "資料";
const MATERIAL_EMPTY_CELL = "-";
const DOCSWELL_FEED_URL = buildDocswellFeedUrl();
const QIITA_FEED_URL = buildQiitaFeedUrl();

let lastRequestAt = 0;

async function main() {
    const readme = await readFile(README_PATH, "utf8");
    const [materialCatalog, blogPosts] = await Promise.all([
        loadDocswellCatalog(),
        loadQiitaPosts(),
    ]);
    const { ownerEvents, relatedEvents } = FIXTURE_FILE
        ? await loadFixture(FIXTURE_FILE)
        : await fetchConnpassEvents(materialCatalog);

    const events = attachMaterials(mergeEvents(ownerEvents, relatedEvents), materialCatalog);
    const { upcomingEvents, archivedEvents } = splitEvents(events, new Date());

    const updatedReadme = replaceSection(
        replaceSection(
            replaceSection(readme, "BLOG-POST-LIST", renderBlogPostList(blogPosts)),
            "CONNPASS-UPCOMING",
            renderTable(upcomingEvents, "No upcoming connpass events found."),
        ),
        "CONNPASS-ARCHIVE",
        renderTable(archivedEvents, "No archived connpass events found."),
    );

    if (updatedReadme === readme) {
        console.log("README is already up to date.");
        return;
    }

    await writeFile(README_PATH, updatedReadme, "utf8");
    console.log(
        `Updated ${path.relative(process.cwd(), README_PATH)} with ${blogPosts.length} blog posts, ${upcomingEvents.length} upcoming events, and ${archivedEvents.length} archived events.`,
    );
}

async function loadFixture(filePath) {
    const fixturePath = path.resolve(filePath);
    const rawFixture = await readFile(fixturePath, "utf8");
    const parsedFixture = JSON.parse(rawFixture);

    return {
        ownerEvents: Array.isArray(parsedFixture.ownerEvents) ? parsedFixture.ownerEvents : [],
        relatedEvents: Array.isArray(parsedFixture.relatedEvents)
            ? parsedFixture.relatedEvents
            : Array.isArray(parsedFixture.presenterEvents)
              ? parsedFixture.presenterEvents
              : [],
    };
}

async function fetchConnpassEvents(materialCatalog) {
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

    const linkedEventIds = extractConnpassEventIds(materialCatalog);
    const relatedEvents = linkedEventIds.length ? await fetchEventsByIds(linkedEventIds) : [];

    return { ownerEvents, relatedEvents };
}

async function loadDocswellCatalog() {
    if (DOCSWELL_FEED_FILE) {
        const fixturePath = path.resolve(DOCSWELL_FEED_FILE);
        const rawFeed = await readFile(fixturePath, "utf8");
        return parseDocswellFeed(rawFeed);
    }

    if (!DOCSWELL_FEED_URL) {
        return createEmptyMaterialCatalog();
    }

    try {
        const response = await fetch(DOCSWELL_FEED_URL, {
            headers: {
                "User-Agent": "Yuyanz9-README-Connpass-Sync",
            },
        });

        if (!response.ok) {
            throw new Error(`Docswell feed request failed: ${response.status} ${response.statusText}`.trim());
        }

        return parseDocswellFeed(await response.text());
    } catch (error) {
        console.warn(`Skipping Docswell material sync: ${error instanceof Error ? error.message : String(error)}`);
        return createEmptyMaterialCatalog();
    }
}

async function loadQiitaPosts() {
    if (QIITA_FEED_FILE) {
        const fixturePath = path.resolve(QIITA_FEED_FILE);
        const rawFeed = await readFile(fixturePath, "utf8");
        return parseQiitaFeed(rawFeed);
    }

    if (!QIITA_FEED_URL) {
        return [];
    }

    const response = await fetch(QIITA_FEED_URL, {
        headers: {
            "User-Agent": "Yuyanz9-README-Blog-Sync",
        },
    });

    if (!response.ok) {
        throw new Error(`Qiita feed request failed: ${response.status} ${response.statusText}`.trim());
    }

    return parseQiitaFeed(await response.text());
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

async function fetchEventsByIds(eventIds) {
    const events = [];

    for (const batch of chunkArray(eventIds, API_EVENT_ID_BATCH_SIZE)) {
        const searchParams = new URLSearchParams({
            count: String(batch.length),
            order: "2",
        });

        for (const eventId of batch) {
            searchParams.append("event_id", String(eventId));
        }

        const payload = await requestConnpassJson(`${API_BASE_URL}/events/?${searchParams.toString()}`);
        const pageEvents = Array.isArray(payload.events) ? payload.events : [];
        events.push(...pageEvents);
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

function mergeEvents(ownerEvents, relatedEvents) {
    const mergedEvents = new Map();

    for (const event of [...ownerEvents, ...relatedEvents]) {
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

function attachMaterials(events, materialCatalog) {
    const usedMaterialUrls = new Set();

    return events.map((event) => {
        const directMaterial = materialCatalog.eventMaterials.get(normalizeConnpassEventUrl(event.url));
        const fallbackMaterial = directMaterial
            ? null
            : findFallbackMaterial(event, materialCatalog.fallbackSlides, usedMaterialUrls);
        const material = directMaterial ?? fallbackMaterial;

        if (material?.materialUrl) {
            usedMaterialUrls.add(material.materialUrl);
        }

        return {
            ...event,
            materialTitle: material?.title ?? "",
            materialUrl: material?.materialUrl ?? "",
        };
    });
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
        "| Date | Event | Community | 資料 |",
        "|------|-------|-----------|------|",
    ];

    const rows = events.map((event) => {
        const eventTitle = escapeLinkText(event.title);
        const communityTitle = escapeLinkText(event.communityTitle || "-");
        const communityCell = event.communityUrl ? `[${communityTitle}](${event.communityUrl})` : communityTitle;
        const materialCell = event.materialUrl ? `[${MATERIAL_LINK_LABEL}](${event.materialUrl})` : MATERIAL_EMPTY_CELL;
        return `| ${formatDateInJst(event.startedAt)} | [${eventTitle}](${event.url}) | ${communityCell} | ${materialCell} |`;
    });

    return [...header, ...rows].join("\n");
}

function renderBlogPostList(posts) {
    if (!posts.length) {
        return "No recent Qiita posts found.";
    }

    return posts.map((post) => `- [${escapeLinkText(post.title)}](${post.url})`).join("\n");
}

function parseDocswellFeed(feedXml) {
    const eventMaterials = new Map();
    const fallbackSlides = [];

    for (const itemXml of matchTagBlocks(feedXml, "item")) {
        const slide = parseDocswellItem(itemXml);

        if (!slide.materialUrl) {
            continue;
        }

        if (slide.eventUrls.length) {
            for (const eventUrl of slide.eventUrls) {
                const existingMaterial = eventMaterials.get(eventUrl);

                if (!existingMaterial || isMoreRecentSlide(slide, existingMaterial)) {
                    eventMaterials.set(eventUrl, slide);
                }
            }

            continue;
        }

        fallbackSlides.push(slide);
    }

    return {
        eventMaterials,
        fallbackSlides,
    };
}

function parseDocswellItem(itemXml) {
    const title = stripDocswellPrefix(decodeXmlEntities(readTagValue(itemXml, "title")));
    const description = decodeXmlEntities(readTagValue(itemXml, "description"));
    const content = decodeXmlEntities(readTagValue(itemXml, "content:encoded"));
    const link = normalizeDocswellUrl(decodeXmlEntities(readTagValue(itemXml, "guid")) || decodeXmlEntities(readTagValue(itemXml, "link")));
    const publishedAt = parsePublishedAt(readTagValue(itemXml, "pubDate"), readTagValue(itemXml, "dc:date"));
    const eventUrls = Array.from(new Set(extractUrls(`${description}\n${content}`).filter(isConnpassEventUrl).map(normalizeConnpassEventUrl)));
    const searchText = normalizeMatchText([title, description, stripHtml(content)].filter(Boolean).join(" "));

    return {
        title,
        materialUrl: link,
        publishedAt,
        eventUrls,
        searchText,
    };
}

function parseQiitaFeed(feedXml) {
    const entryBlocks = matchTagBlocks(feedXml, "entry");
    const itemBlocks = entryBlocks.length ? entryBlocks : matchTagBlocks(feedXml, "item");

    return itemBlocks
        .map((itemXml) => ({
            title: decodeXmlEntities(readTagValue(itemXml, "title")),
            url:
                decodeXmlEntities(readTagAttribute(itemXml, "link", "href", { rel: "alternate" })) ||
                decodeXmlEntities(readTagValue(itemXml, "url")) ||
                decodeXmlEntities(readTagValue(itemXml, "link")) ||
                decodeXmlEntities(readTagValue(itemXml, "guid")),
        }))
        .filter((post) => post.title && post.url)
        .slice(0, Number.isFinite(MAX_QIITA_POSTS) && MAX_QIITA_POSTS > 0 ? MAX_QIITA_POSTS : 5);
}

function findFallbackMaterial(event, fallbackSlides, usedMaterialUrls) {
    const eventTime = new Date(event.startedAt).getTime();

    if (Number.isNaN(eventTime)) {
        return null;
    }

    const communityNeedles = buildCommunityNeedles(event);

    if (!communityNeedles.length) {
        return null;
    }

    const candidates = fallbackSlides
        .filter((slide) => !usedMaterialUrls.has(slide.materialUrl))
        .map((slide) => {
            const slideTime = Date.parse(slide.publishedAt);
            const diffDays = Number.isNaN(slideTime) ? Number.POSITIVE_INFINITY : Math.abs(slideTime - eventTime) / 86_400_000;
            const matchesCommunity = communityNeedles.some((needle) => slide.searchText.includes(needle));

            return {
                slide,
                diffDays,
                matchesCommunity,
            };
        })
        .filter((candidate) => candidate.matchesCommunity && candidate.diffDays <= DOCSWELL_MATCH_WINDOW_DAYS)
        .sort((left, right) => left.diffDays - right.diffDays || right.slide.searchText.length - left.slide.searchText.length);

    return candidates[0]?.slide ?? null;
}

function buildCommunityNeedles(event) {
    const needles = new Set();
    const normalizedCommunityTitle = normalizeMatchText(event.communityTitle);

    if (normalizedCommunityTitle) {
        needles.add(normalizedCommunityTitle);
    }

    for (const communityUrl of [event.communityUrl, fallbackCommunityUrl(event.url)]) {
        try {
            const parsedUrl = new URL(String(communityUrl));
            const subdomain = parsedUrl.hostname.split(".")[0]?.trim();

            if (subdomain) {
                needles.add(normalizeMatchText(subdomain));
            }
        } catch {
            // Ignore malformed community URLs while building fallback match keys.
        }
    }

    return Array.from(needles).filter((needle) => needle.length >= 3);
}

function createEmptyMaterialCatalog() {
    return {
        eventMaterials: new Map(),
        fallbackSlides: [],
    };
}

function extractConnpassEventIds(materialCatalog) {
    const eventIds = new Set();

    for (const eventUrl of materialCatalog.eventMaterials.keys()) {
        const eventId = extractConnpassEventId(eventUrl);

        if (eventId) {
            eventIds.add(eventId);
        }
    }

    return Array.from(eventIds);
}

function buildDocswellFeedUrl() {
    const configuredFeedUrl = process.env.DOCSWELL_FEED_URL?.trim();

    if (configuredFeedUrl) {
        return configuredFeedUrl;
    }

    const docswellUsername = process.env.DOCSWELL_USERNAME?.trim() || CONNPASS_NICKNAME;
    return docswellUsername ? `https://docswell.com/user/${encodeURIComponent(docswellUsername)}/feed` : "";
}

function buildQiitaFeedUrl() {
    const configuredFeedUrl = process.env.QIITA_FEED_URL?.trim();

    if (configuredFeedUrl) {
        return configuredFeedUrl;
    }

    const qiitaUsername = process.env.QIITA_USERNAME?.trim();
    return qiitaUsername ? `https://qiita.com/${encodeURIComponent(qiitaUsername)}/feed` : "";
}

function matchTagBlocks(content, tagName) {
    const tagPattern = new RegExp(`<${escapeRegExp(tagName)}[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "gi");
    return Array.from(content.matchAll(tagPattern), (match) => match[1]);
}

function readTagValue(content, tagName) {
    const match = new RegExp(`<${escapeRegExp(tagName)}[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "i").exec(content);
    return match ? unwrapCdata(match[1]).trim() : "";
}

function readTagAttribute(content, tagName, attributeName, requiredAttributes = {}) {
    const tagPattern = new RegExp(`<${escapeRegExp(tagName)}\\b([^>]*)>`, "gi");

    for (const match of content.matchAll(tagPattern)) {
        const attributeText = match[1] ?? "";
        const attributes = Object.fromEntries(
            Array.from(attributeText.matchAll(/([^\s=]+)\s*=\s*"([^"]*)"/g), (attributeMatch) => [attributeMatch[1], attributeMatch[2]]),
        );

        const hasRequiredAttributes = Object.entries(requiredAttributes).every(
            ([attributeKey, attributeValue]) => attributes[attributeKey] === attributeValue,
        );

        if (hasRequiredAttributes && attributes[attributeName]) {
            return attributes[attributeName];
        }
    }

    return "";
}

function unwrapCdata(value) {
    return String(value)
        .replace(/^<!\[CDATA\[/, "")
        .replace(/\]\]>$/, "");
}

function stripDocswellPrefix(value) {
    return String(value).replace(/^\[スライド\]\s*/u, "").trim();
}

function parsePublishedAt(pubDate, dcDate) {
    const parsedDate = Date.parse(pubDate || dcDate || "");
    return Number.isNaN(parsedDate) ? "" : new Date(parsedDate).toISOString();
}

function normalizeDocswellUrl(url) {
    if (!url) {
        return "";
    }

    try {
        const parsedUrl = new URL(String(url));
        parsedUrl.hash = "";
        parsedUrl.search = "";
        return parsedUrl.toString();
    } catch {
        return String(url).trim().replace(/\?ref=rss$/i, "");
    }
}

function extractUrls(value) {
    return Array.from(String(value).matchAll(/https?:\/\/[^\s"'<>]+/g), (match) => trimTrailingUrlPunctuation(match[0]));
}

function trimTrailingUrlPunctuation(value) {
    return String(value).replace(/[),.;]+$/g, "");
}

function isConnpassEventUrl(url) {
    try {
        const parsedUrl = new URL(String(url));
        return /(^|\.)connpass\.com$/i.test(parsedUrl.hostname) && /^\/event\/\d+\/?$/i.test(parsedUrl.pathname);
    } catch {
        return false;
    }
}

function normalizeConnpassEventUrl(url) {
    try {
        const parsedUrl = new URL(String(url));
        parsedUrl.hash = "";
        parsedUrl.search = "";
        parsedUrl.hostname = parsedUrl.hostname.toLowerCase();
        parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "") || "/";
        return parsedUrl.toString();
    } catch {
        return String(url).trim().replace(/[/?#]+$/g, "");
    }
}

function extractConnpassEventId(url) {
    try {
        const parsedUrl = new URL(String(url));
        const match = /^\/event\/(\d+)\/?$/i.exec(parsedUrl.pathname);
        return match ? Number.parseInt(match[1], 10) : null;
    } catch {
        return null;
    }
}

function normalizeMatchText(value) {
    return String(value)
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\u3000\s]+/g, " ")
        .trim();
}

function stripHtml(value) {
    return String(value)
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/[\u3000\s]+/g, " ")
        .trim();
}

function decodeXmlEntities(value) {
    return String(value)
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, hexCode) => String.fromCodePoint(Number.parseInt(hexCode, 16)))
        .replace(/&#(\d+);/g, (_, charCode) => String.fromCodePoint(Number.parseInt(charCode, 10)))
        .replace(/&amp;/g, "&");
}

function isMoreRecentSlide(left, right) {
    return Date.parse(left.publishedAt || "") >= Date.parse(right.publishedAt || "");
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function chunkArray(values, chunkSize) {
    const chunks = [];

    for (let index = 0; index < values.length; index += chunkSize) {
        chunks.push(values.slice(index, index + chunkSize));
    }

    return chunks;
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
