import { constants as fsConstants } from "node:fs";
import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ConnpassRequestError, createConnpassRequester } from "./connpass-api.mjs";

const README_PATH = path.resolve(process.env.README_PATH ?? "README.md");
const DEFAULT_MANUAL_EVENTS_FILE = path.resolve(".github/scripts/manual-events.json");
const FIXTURE_FILE = process.env.CONNPASS_FIXTURE_FILE?.trim();
const DOCSWELL_FEED_FILE = process.env.DOCSWELL_FEED_FILE?.trim();
const MANUAL_EVENTS_FILE = process.env.MANUAL_EVENTS_FILE?.trim() || DEFAULT_MANUAL_EVENTS_FILE;
const QIITA_FEED_FILE = process.env.QIITA_FEED_FILE?.trim();
const CONNPASS_API_KEY = process.env.CONNPASS_API_KEY?.trim();
const CONNPASS_NICKNAME = process.env.CONNPASS_NICKNAME?.trim();
const CONNPASS_MANAGED_SUBDOMAIN = process.env.CONNPASS_MANAGED_SUBDOMAIN?.trim();
const MAX_QIITA_POSTS = Number.parseInt(process.env.MAX_QIITA_POSTS ?? "5", 10);
const API_BASE_URL = "https://connpass.com/api/v2";
const API_PAGE_SIZE = 100;
const JST_TIME_ZONE = "Asia/Tokyo";
const DOCSWELL_MATCH_WINDOW_DAYS = 7;
const MATERIAL_LINK_LABEL = "資料";
const MATERIAL_EMPTY_CELL = "-";
const DOCSWELL_FEED_URL = buildDocswellFeedUrl();
const QIITA_FEED_URL = buildQiitaFeedUrl();
const QIITA_PROFILE_API_URL = buildQiitaProfileApiUrl();
const QIITA_ITEMS_API_URL = buildQiitaItemsApiUrl();

const requestConnpassJson = createConnpassRequester(CONNPASS_API_KEY);

async function main() {
    const readme = await readFile(README_PATH, "utf8");
    const existingReadmeEvents = parseExistingReadmeEvents(readme);
    const [materialCatalog, qiitaCatalog, manualConfig] = await Promise.all([
        loadDocswellCatalog(),
        loadQiitaCatalog(),
        loadManualConfig(),
    ]);
    const manualEvents = manualConfig.events;
    let connpassFailed = false;
    let presenterEvents = [];
    let managedEvents = [];
    try {
        ({ presenterEvents, managedEvents } = FIXTURE_FILE
            ? await loadFixture(FIXTURE_FILE)
            : await fetchConnpassEvents(materialCatalog));
    } catch (error) {
        if (!(error instanceof ConnpassRequestError)) {
            throw error;
        }
        connpassFailed = true;
        console.warn(`::warning::Connpass sync skipped; existing event information is preserved. ${error.message.replace(/[\r\n]/g, " ")}`);
    }

    const managedCountMatch = /イベント運営数:\s*\*\*(\d+)\*\*/u.exec(extractSectionContent(readme, "ABOUT-ME-STATS"));
    if (!managedCountMatch) {
        throw new Error("Cannot preserve the existing managed event count in ABOUT-ME-STATS.");
    }
    const managedEventCount = Number(managedCountMatch[1]);

    const syncedEvents = mergeEvents(presenterEvents, managedEvents, manualEvents);
    const events = attachMaterials(
        mergeNormalizedEvents(existingReadmeEvents, syncedEvents),
        materialCatalog,
        manualConfig.materials,
    );
    const { upcomingEvents, archivedEvents } = splitEvents(events, new Date());
    const profileStats = {
        articleCount: qiitaCatalog.totalPosts,
        materialCount: materialCatalog.totalMaterials,
        managedEventCount,
    };

    const updatedReadme = replaceSection(
        replaceSection(
            replaceSection(readme, "BLOG-POST-LIST", renderBlogPostList(qiitaCatalog.recentPosts)),
            "ABOUT-ME-STATS",
            renderAboutMeStats(profileStats),
        ),
        "CONNPASS-UPCOMING",
        renderTable(upcomingEvents, "No upcoming connpass events found.", { includeMaterials: false }),
    );
    const finalizedReadme = replaceSection(
        updatedReadme,
        "CONNPASS-ARCHIVE",
        renderTable(archivedEvents, "No archived connpass events found."),
    );

    if (finalizedReadme === readme) {
        console.log("README is already up to date.");
    } else {
        await writeFile(README_PATH, finalizedReadme, "utf8");
        console.log(
            `Updated ${path.relative(process.cwd(), README_PATH)} with ${qiitaCatalog.recentPosts.length} blog posts, ${upcomingEvents.length} upcoming events, and ${archivedEvents.length} archived events.`,
        );
    }

    if (process.env.GITHUB_OUTPUT) {
        await appendFile(process.env.GITHUB_OUTPUT, `connpass_failed=${connpassFailed}\n`);
    } else if (connpassFailed) {
        process.exitCode = 1;
    }
}

async function loadManualConfig() {
    const manualEventsPath = path.resolve(MANUAL_EVENTS_FILE);

    if (!(await fileExists(manualEventsPath))) {
        return {
            events: [],
            materials: new Map(),
        };
    }

    const rawManualConfig = await readFile(manualEventsPath, "utf8");
    const parsedManualConfig = JSON.parse(rawManualConfig);
    const events = Array.isArray(parsedManualConfig)
        ? parsedManualConfig
        : Array.isArray(parsedManualConfig.events)
          ? parsedManualConfig.events
          : Array.isArray(parsedManualConfig.manualEvents)
            ? parsedManualConfig.manualEvents
            : [];
    const configuredMaterials = Array.isArray(parsedManualConfig.materials)
        ? parsedManualConfig.materials
        : Array.isArray(parsedManualConfig.manualMaterials)
          ? parsedManualConfig.manualMaterials
          : [];
    const materials = new Map();

    for (const material of configuredMaterials) {
        const eventUrl = normalizeEventUrl(material?.event_url ?? material?.eventUrl ?? material?.url ?? "");
        const materialUrl = normalizeDocswellUrl(material?.material_url ?? material?.materialUrl ?? material?.slide_url ?? material?.slideUrl ?? "");

        if (!eventUrl || !materialUrl) {
            continue;
        }

        materials.set(eventUrl, {
            title: typeof material?.title === "string" ? material.title.trim() : "",
            materialUrl,
        });
    }

    return { events, materials };
}

async function loadFixture(filePath) {
    const fixturePath = path.resolve(filePath);
    const rawFixture = await readFile(fixturePath, "utf8");
    const parsedFixture = JSON.parse(rawFixture);

    return {
        presenterEvents: Array.isArray(parsedFixture.presenterEvents)
            ? parsedFixture.presenterEvents
            : Array.isArray(parsedFixture.attendedEvents)
            ? parsedFixture.attendedEvents
            : Array.isArray(parsedFixture.relatedEvents)
              ? parsedFixture.relatedEvents
              : [],
        managedEvents: Array.isArray(parsedFixture.managedEvents)
            ? parsedFixture.managedEvents
            : Array.isArray(parsedFixture.ownerEvents)
              ? parsedFixture.ownerEvents
              : [],
    };
}

async function fetchConnpassEvents(materialCatalog) {
    if (!CONNPASS_API_KEY) {
        throw new ConnpassRequestError("Missing CONNPASS_API_KEY. Configure it as a GitHub Actions secret before running this script.");
    }

    const managedEvents = CONNPASS_MANAGED_SUBDOMAIN
        ? await fetchPaginatedEvents((start) => {
              const searchParams = new URLSearchParams({
                  subdomain: CONNPASS_MANAGED_SUBDOMAIN,
                  order: "2",
                  start: String(start),
                  count: String(API_PAGE_SIZE),
              });
              return `${API_BASE_URL}/events/?${searchParams.toString()}`;
          })
        : [];
    const presenterEvents = await fetchEventsByUrls(Array.from(materialCatalog.eventMaterials.keys()));

    return { presenterEvents, managedEvents };
}

async function fetchEventsByUrls(eventUrls) {
    const presenterEvents = [];
    const ids = Array.from(new Set(eventUrls.map(parseConnpassEventId).filter(Boolean)));

    for (let index = 0; index < ids.length; index += API_PAGE_SIZE) {
        const batch = ids.slice(index, index + API_PAGE_SIZE);
        const events = await fetchPaginatedEvents((start) => {
            const searchParams = new URLSearchParams({
                event_id: batch.join(","),
                start: String(start),
                count: String(API_PAGE_SIZE),
            });
            return `${API_BASE_URL}/events/?${searchParams.toString()}`;
        });
        presenterEvents.push(...events);
        const foundIds = new Set(events.map((event) => Number(event.id)));
        for (const id of batch) {
            if (!foundIds.has(id)) {
                console.warn(`Skipping unresolved Docswell-linked connpass event ID: ${id}`);
            }
        }
    }

    return presenterEvents;
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

async function loadQiitaCatalog() {
    if (QIITA_FEED_FILE) {
        const fixturePath = path.resolve(QIITA_FEED_FILE);
        const rawFeed = await readFile(fixturePath, "utf8");
        return buildQiitaCatalog(parseQiitaFeed(rawFeed));
    }

    if (!QIITA_ITEMS_API_URL || !QIITA_PROFILE_API_URL) {
        return createEmptyQiitaCatalog();
    }

    const [recentPosts, totalPosts] = await Promise.all([
        fetchQiitaRecentPosts(),
        fetchQiitaPostCount(),
    ]);

    return buildQiitaCatalog(recentPosts, totalPosts);
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

function mergeEvents(...eventGroups) {
    const mergedEvents = new Map();

    for (const eventGroup of eventGroups) {
        for (const event of eventGroup) {
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
    }

    return Array.from(mergedEvents.values());
}

function attachMaterials(events, materialCatalog, manualMaterials = new Map()) {
    const usedMaterialUrls = new Set();

    return events.map((event) => {
        const manualMaterial = manualMaterials.get(normalizeEventUrl(event.url));
        const directMaterial = manualMaterial ?? materialCatalog.eventMaterials.get(normalizeConnpassEventUrl(event.url));
        const fallbackMaterial = directMaterial
            ? null
            : findFallbackMaterial(event, materialCatalog.fallbackSlides, usedMaterialUrls);
        const material = directMaterial ?? fallbackMaterial;

        if (material?.materialUrl) {
            usedMaterialUrls.add(material.materialUrl);
        }

        return {
            ...event,
            materialTitle: material?.title ?? event.materialTitle ?? "",
            materialUrl: material?.materialUrl ?? event.materialUrl ?? "",
        };
    });
}

function parseExistingReadmeEvents(readme) {
    return mergeNormalizedEvents(
        parseReadmeEventTable(extractSectionContent(readme, "CONNPASS-UPCOMING"), "upcoming"),
        parseReadmeEventTable(extractSectionContent(readme, "CONNPASS-ARCHIVE"), "archive"),
    );
}

function extractSectionContent(content, tagName) {
    const markerPattern = new RegExp(`<!-- ${escapeRegExp(tagName)}:START -->([\\s\\S]*?)<!-- ${escapeRegExp(tagName)}:END -->`);
    const match = markerPattern.exec(content);
    return match?.[1] ?? "";
}

function parseReadmeEventTable(sectionContent, sectionType) {
    return sectionContent
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("|"))
        .filter((line) => !/^\|[-\s|]+\|$/.test(line))
        .filter((line) => !line.includes("| Date | Event | Community"))
        .map((line) => parseReadmeEventRow(line, sectionType))
        .filter(Boolean);
}

function parseReadmeEventRow(row, sectionType) {
    const cells = splitMarkdownTableRow(row);

    if (cells.length < 3) {
        return null;
    }

    const [dateCell, eventCell, communityCell, materialCell = ""] = cells;
    const eventLink = parseMarkdownLink(eventCell);

    if (!dateCell || !eventLink?.url || !eventLink.text) {
        return null;
    }

    const communityLink = parseMarkdownLink(communityCell);
    const materialLink = parseMarkdownLink(materialCell);

    return {
        id: parseConnpassEventId(eventLink.url) ?? normalizeEventUrl(eventLink.url),
        title: eventLink.text,
        url: eventLink.url,
        startedAt: parseReadmeEventDate(dateCell, sectionType),
        updatedAt: parseReadmeEventDate(dateCell, sectionType),
        communityTitle: communityLink?.text ?? (communityCell.trim() || "-"),
        communityUrl: communityLink?.url ?? "",
        materialTitle: materialLink?.text ?? "",
        materialUrl: materialLink?.url ?? "",
    };
}

function splitMarkdownTableRow(row) {
    const trimmedRow = row.trim().replace(/^\|/, "").replace(/\|$/, "");
    const cells = [];
    let current = "";

    for (let index = 0; index < trimmedRow.length; index += 1) {
        const character = trimmedRow[index];
        const previousCharacter = index > 0 ? trimmedRow[index - 1] : "";

        if (character === "|" && previousCharacter !== "\\") {
            cells.push(current.trim());
            current = "";
            continue;
        }

        current += character;
    }

    if (current) {
        cells.push(current.trim());
    }

    return cells;
}

function parseMarkdownLink(value) {
    const match = /^\[([\s\S]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(value.trim());

    if (!match) {
        return null;
    }

    return {
        text: match[1].trim(),
        url: match[2].trim(),
    };
}

function parseReadmeEventDate(value, sectionType) {
    const timeSuffix = sectionType === "upcoming" ? "T23:59:59+09:00" : "T00:00:00+09:00";
    const parsed = Date.parse(`${value.trim()}${timeSuffix}`);
    return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString();
}

function mergeNormalizedEvents(...eventSets) {
    const mergedEvents = new Map();

    for (const event of eventSets.flat()) {
        if (!event || !event.title || !event.url || !event.startedAt) {
            continue;
        }

        const eventKey = normalizeEventUrl(event.url);
        const existingEvent = mergedEvents.get(eventKey);

        if (!existingEvent || isMoreRecentEvent(event, existingEvent)) {
            mergedEvents.set(eventKey, event);
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

function renderTable(events, emptyMessage, options = {}) {
    const { includeMaterials = true } = options;

    if (!events.length) {
        return emptyMessage;
    }

    const header = includeMaterials
        ? [
              "| Date | Event | Community | 資料 |",
              "|------|-------|-----------|------|",
          ]
        : [
              "| Date | Event | Community |",
              "|------|-------|-----------|",
          ];

    const rows = events.map((event) => {
        const eventTitle = escapeLinkText(event.title);
        const communityTitle = escapeLinkText(event.communityTitle || "-");
        const communityCell = event.communityUrl ? `[${communityTitle}](${event.communityUrl})` : communityTitle;
        const materialCell = event.materialUrl ? `[${MATERIAL_LINK_LABEL}](${event.materialUrl})` : MATERIAL_EMPTY_CELL;
        return includeMaterials
            ? `| ${formatDateInJst(event.startedAt)} | [${eventTitle}](${event.url}) | ${communityCell} | ${materialCell} |`
            : `| ${formatDateInJst(event.startedAt)} | [${eventTitle}](${event.url}) | ${communityCell} |`;
    });

    return [...header, ...rows].join("\n");
}

function renderAboutMeStats(stats) {
    return `- ✍️ 記事数: **${stats.articleCount}**\n- 🎤 登壇数（登壇資料数）: **${stats.materialCount}**\n- 🤝 イベント運営数: **${stats.managedEventCount}**`;
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
    let totalMaterials = 0;

    for (const itemXml of matchTagBlocks(feedXml, "item")) {
        const slide = parseDocswellItem(itemXml);

        if (!slide.materialUrl) {
            continue;
        }

        totalMaterials += 1;

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
        totalMaterials,
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
}

async function fetchQiitaPostCount() {
    const profile = await fetchQiitaJson(QIITA_PROFILE_API_URL, "Qiita profile");
    return Number.isFinite(Number(profile?.items_count)) ? Number(profile.items_count) : 0;
}

async function fetchQiitaRecentPosts() {
    const items = await fetchQiitaJson(QIITA_ITEMS_API_URL, "Qiita items");

    if (!Array.isArray(items)) {
        throw new Error("Qiita items response was not an array.");
    }

    return items
        .map((item) => ({
            title: typeof item?.title === "string" ? item.title : "",
            url: typeof item?.url === "string" ? item.url : "",
        }))
        .filter((post) => post.title && post.url);
}

async function fetchQiitaJson(url, label) {
    if (!url) {
        throw new Error(`Missing ${label} URL.`);
    }

    const response = await fetch(url, {
        headers: {
            "User-Agent": "Yuyanz9-README-Blog-Sync",
        },
    });

    if (!response.ok) {
        throw new Error(`${label} request failed: ${response.status} ${response.statusText}`.trim());
    }

    return response.json();
}

function buildQiitaCatalog(posts, totalPosts = posts.length) {
    const maxPosts = Number.isFinite(MAX_QIITA_POSTS) && MAX_QIITA_POSTS > 0 ? MAX_QIITA_POSTS : 5;

    return {
        recentPosts: posts.slice(0, maxPosts),
        totalPosts,
    };
}

function createEmptyQiitaCatalog() {
    return {
        recentPosts: [],
        totalPosts: 0,
    };
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
        totalMaterials: 0,
    };
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

function buildQiitaProfileApiUrl() {
    const qiitaUsername = process.env.QIITA_USERNAME?.trim();
    return qiitaUsername ? `https://qiita.com/api/v2/users/${encodeURIComponent(qiitaUsername)}` : "";
}

function buildQiitaItemsApiUrl() {
    const qiitaUsername = process.env.QIITA_USERNAME?.trim();
    const perPage = Number.isFinite(MAX_QIITA_POSTS) && MAX_QIITA_POSTS > 0 ? MAX_QIITA_POSTS : 5;
    return qiitaUsername
        ? `https://qiita.com/api/v2/users/${encodeURIComponent(qiitaUsername)}/items?page=1&per_page=${perPage}`
        : "";
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

function normalizeEventUrl(url) {
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

function parseConnpassEventId(url) {
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

function isMoreRecentEvent(left, right) {
    return Date.parse(left.updatedAt || left.startedAt || "") >= Date.parse(right.updatedAt || right.startedAt || "");
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

async function fileExists(filePath) {
    try {
        await access(filePath, fsConstants.F_OK);
        return true;
    } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
            return false;
        }

        throw error;
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
