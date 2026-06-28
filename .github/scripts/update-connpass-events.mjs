import { constants as fsConstants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const README_PATH = path.resolve(process.env.README_PATH ?? "README.md");
const DEFAULT_MANUAL_EVENTS_FILE = path.resolve(".github/scripts/manual-events.json");
const FIXTURE_FILE = process.env.CONNPASS_FIXTURE_FILE?.trim();
const DOCSWELL_FEED_FILE = process.env.DOCSWELL_FEED_FILE?.trim();
const MANUAL_EVENTS_FILE = process.env.MANUAL_EVENTS_FILE?.trim() || DEFAULT_MANUAL_EVENTS_FILE;
const QIITA_FEED_FILE = process.env.QIITA_FEED_FILE?.trim();
const CONNPASS_API_KEY = process.env.CONNPASS_API_KEY?.trim();
const CONNPASS_NICKNAME = process.env.CONNPASS_NICKNAME?.trim();
const CONNPASS_USER_ID = process.env.CONNPASS_USER_ID?.trim();
const CONNPASS_MANAGED_SUBDOMAIN = process.env.CONNPASS_MANAGED_SUBDOMAIN?.trim();
const MAX_QIITA_POSTS = Number.parseInt(process.env.MAX_QIITA_POSTS ?? "5", 10);
const API_BASE_URL = "https://connpass.com/api/v2";
const API_PAGE_SIZE = 100;
const JST_TIME_ZONE = "Asia/Tokyo";
const API_REQUEST_INTERVAL_MS = 1100;
const DOCSWELL_MATCH_WINDOW_DAYS = 7;
const MATERIAL_LINK_LABEL = "資料";
const MATERIAL_EMPTY_CELL = "-";
const DOCSWELL_FEED_URL = buildDocswellFeedUrl();
const QIITA_FEED_URL = buildQiitaFeedUrl();
const QIITA_PROFILE_API_URL = buildQiitaProfileApiUrl();
const QIITA_ITEMS_API_URL = buildQiitaItemsApiUrl();
const CONNPASS_MANAGED_PROFILE_URL = buildConnpassManagedProfileUrl(1);

let lastRequestAt = 0;

async function main() {
    const readme = await readFile(README_PATH, "utf8");
    const [materialCatalog, qiitaCatalog, manualConfig] = await Promise.all([
        loadDocswellCatalog(),
        loadQiitaCatalog(),
        loadManualConfig(),
    ]);
    const manualEvents = manualConfig.events;
    const managedProfileSnapshot = FIXTURE_FILE ? null : await fetchConnpassManagedProfileSnapshot();
    const { presenterEvents, managedEvents } = FIXTURE_FILE
        ? await loadFixture(FIXTURE_FILE)
        : await fetchConnpassEvents(materialCatalog, managedProfileSnapshot);
    const managedEventCount = resolveManagedEventCount(managedEvents, manualEvents, managedProfileSnapshot);

    const events = attachMaterials(mergeEvents(presenterEvents, managedEvents, manualEvents), materialCatalog, manualConfig.materials);
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
        return;
    }

    await writeFile(README_PATH, finalizedReadme, "utf8");
    console.log(
        `Updated ${path.relative(process.cwd(), README_PATH)} with ${qiitaCatalog.recentPosts.length} blog posts, ${upcomingEvents.length} upcoming events, and ${archivedEvents.length} archived events.`,
    );
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

async function fetchConnpassEvents(materialCatalog, managedProfileSnapshot = null) {
    if (!CONNPASS_API_KEY) {
        throw new Error("Missing CONNPASS_API_KEY. Configure it as a GitHub Actions secret before running this script.");
    }

    const [subdomainManagedEvents, hostedManagedEvents, presenterEvents] = await Promise.all([
        CONNPASS_MANAGED_SUBDOMAIN
            ? fetchPaginatedEvents((start) => {
                  const searchParams = new URLSearchParams({
                      subdomain: CONNPASS_MANAGED_SUBDOMAIN,
                      order: "2",
                      start: String(start),
                      count: String(API_PAGE_SIZE),
                  });

                  return `${API_BASE_URL}/events/?${searchParams.toString()}`;
              })
            : [],
        managedProfileSnapshot?.events?.length ? managedProfileSnapshot.events : [],
        fetchEventsByUrls(Array.from(materialCatalog.eventMaterials.keys())),
    ]);
    const managedEvents = mergeEvents(subdomainManagedEvents, hostedManagedEvents);

    return { presenterEvents, managedEvents };
}

async function fetchEventsByUrls(eventUrls) {
    const presenterEvents = [];
    const seenEventIds = new Set();

    for (const eventUrl of eventUrls) {
        const eventId = parseConnpassEventId(eventUrl);

        if (!eventId || seenEventIds.has(eventId)) {
            continue;
        }

        const searchParams = new URLSearchParams({
            event_id: String(eventId),
            count: "1",
        });
        const payload = await requestConnpassJson(`${API_BASE_URL}/events/?${searchParams.toString()}`);
        const event = Array.isArray(payload.events) ? payload.events[0] : null;

        if (!event) {
            console.warn(`Skipping unresolved Docswell-linked connpass event: ${eventUrl}`);
            continue;
        }

        presenterEvents.push(event);
        seenEventIds.add(eventId);
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

function countManagedEvents(managedEvents, manualEvents) {
    return mergeEvents(managedEvents, manualEvents.filter(isManagedCommunityEvent)).length;
}

function resolveManagedEventCount(managedEvents, manualEvents, managedProfileSnapshot = null) {
    if (managedProfileSnapshot?.count != null) {
        return managedProfileSnapshot.count;
    }

    return countManagedEvents(managedEvents, manualEvents);
}

async function fetchConnpassManagedProfileSnapshot() {
    if (!CONNPASS_MANAGED_PROFILE_URL) {
        return null;
    }

    try {
        return await loadConnpassManagedProfileSnapshot();
    } catch (error) {
        console.warn(`Falling back to community-managed event count: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

async function loadConnpassManagedProfileSnapshot() {
    const firstPageHtml = await fetchText(CONNPASS_MANAGED_PROFILE_URL, "Yuyanz9-README-Connpass-Profile-Sync");
    const lastPage = extractLastPageNumber(firstPageHtml);
    const pageHtmls = [firstPageHtml];

    if (lastPage > 1) {
        pageHtmls.push(
            ...(await Promise.all(
                Array.from({ length: lastPage - 1 }, (_, index) =>
                    fetchText(buildConnpassManagedProfileUrl(index + 2), "Yuyanz9-README-Connpass-Profile-Sync"),
                ),
            )),
        );
    }

    return {
        count: pageHtmls.reduce((totalCount, pageHtml) => totalCount + countEventCards(pageHtml), 0),
        events: extractConnpassManagedEvents(pageHtmls),
    };
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
            materialTitle: material?.title ?? "",
            materialUrl: material?.materialUrl ?? "",
        };
    });
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

function isManagedCommunityEvent(event) {
    if (event?.managed_by_community === true) {
        return true;
    }

    if (!CONNPASS_MANAGED_SUBDOMAIN) {
        return false;
    }

    try {
        const communityUrl = String(event.group?.url ?? "");
        const parsedUrl = new URL(communityUrl);
        return parsedUrl.hostname.split(".")[0]?.toLowerCase() === CONNPASS_MANAGED_SUBDOMAIN.toLowerCase();
    } catch {
        return false;
    }
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

function buildConnpassManagedProfileUrl(page) {
    return CONNPASS_USER_ID ? `https://connpass.com/user/${encodeURIComponent(CONNPASS_USER_ID)}/open/?page=${page}` : "";
}

async function fetchText(url, userAgent) {
    const response = await fetch(url, {
        headers: {
            "User-Agent": userAgent,
        },
    });

    if (!response.ok) {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`.trim());
    }

    return response.text();
}

function extractLastPageNumber(html) {
    const pageNumbers = Array.from(html.matchAll(/\?page=(\d+)/g), (match) => Number.parseInt(match[1], 10)).filter(Number.isFinite);
    return pageNumbers.length ? Math.max(...pageNumbers) : 1;
}

function countEventCards(html) {
    return Array.from(html.matchAll(/class="event_list vevent"/g)).length;
}

function extractConnpassManagedEvents(pageHtmls) {
    const events = new Map();

    for (const html of pageHtmls) {
        for (const match of html.matchAll(/<div class="event_list vevent">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g)) {
            const event = parseConnpassManagedEventBlock(match[1]);

            if (!event) {
                continue;
            }

            events.set(event.id, event);
        }
    }

    return Array.from(events.values());
}

function parseConnpassManagedEventBlock(blockHtml) {
    const url = readRegexGroup(blockHtml, /<a class="url summary" href="(https?:\/\/[^"]+\/event\/\d+\/?)"/);
    const title = stripHtml(readRegexGroup(blockHtml, /<a class="url summary" href="[^"]+">([\s\S]*?)<\/a>/));
    const groupTitle = stripHtml(readRegexGroup(blockHtml, /<span class="series_title">([\s\S]*?)<\/span>/));
    const groupUrl = readRegexGroup(blockHtml, /<span class="label_group[\s\S]*?<a href="(https?:\/\/[^"]+\.connpass\.com\/)"/);
    const startedAtUtc = readRegexGroup(blockHtml, /<span class="value-title" title="([^"]+)"/);
    const eventId = parseConnpassEventId(url);

    if (!url || !title || !startedAtUtc || !eventId) {
        return null;
    }

    return {
        id: eventId,
        title,
        url: normalizeConnpassEventUrl(url),
        started_at: new Date(startedAtUtc).toISOString(),
        updated_at: new Date(startedAtUtc).toISOString(),
        group: {
            title: groupTitle,
            url: groupUrl,
        },
    };
}

function matchTagBlocks(content, tagName) {
    const tagPattern = new RegExp(`<${escapeRegExp(tagName)}[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "gi");
    return Array.from(content.matchAll(tagPattern), (match) => match[1]);
}

function readRegexGroup(content, pattern) {
    const match = pattern.exec(content);
    return match?.[1]?.trim() ?? "";
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

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
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
