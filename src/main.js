import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { chromium } from 'playwright';
import {
    detectWalmartPageState,
    extractSearchItemsFromJson,
    extractWalmartItemId,
    parseWalmartPrice,
    parseWalmartProductHtml,
    parseWalmartRating,
    parseWalmartSearchHtml,
} from './extractors.js';

function sanitizeRecord(obj) {
    if (obj === null || obj === undefined) return undefined;
    if (typeof obj === 'number') return Number.isFinite(obj) ? obj : undefined;
    if (Array.isArray(obj)) {
        return obj.map(sanitizeRecord).filter((v) => v !== undefined);
    }
    if (typeof obj === 'object' && !(obj instanceof Date)) {
        const clean = {};
        for (const [k, v] of Object.entries(obj)) {
            const val = sanitizeRecord(v);
            if (val !== undefined) clean[k] = val;
        }
        return clean;
    }
    return obj;
}

function isProxyTransportError(errOrStatus) {
    if (errOrStatus === 597 || errOrStatus === 407 || errOrStatus === 502) return true;
    const msg = String(errOrStatus?.message || errOrStatus || '');
    return /597|UPSTREAM407|407|502|Proxy responded with|tunneling socket|ERR_TUNNEL|ERR_PROXY|ERR_CONNECTION_RESET|ERR_SSL|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket hang up/i.test(msg);
}

function parsePlaywrightProxy(proxyUrlStr) {
    if (!proxyUrlStr) return undefined;
    try {
        const u = new URL(proxyUrlStr);
        return {
            server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`,
            ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
            ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
        };
    } catch {
        return { server: proxyUrlStr };
    }
}

await Actor.init();

let activeBrowser = null;
const diagnostics = [];
let totalProductsScraped = 0;
let inStockCount = 0;
let rollbackDealsCount = 0;

const closeActiveBrowser = async () => {
    if (!activeBrowser) return;
    const instance = activeBrowser;
    activeBrowser = null;
    try {
        await instance.close();
    } catch {
        // Ignore close errors during shutdown
    }
};

Actor.on('aborting', async () => {
    try {
        await closeActiveBrowser();
        await Actor.setValue('OUTPUT', {
            totalProductsScraped,
            inStockCount,
            rollbackDealsCount,
            diagnostics,
            status: 'ABORTED',
            scrapedAt: new Date().toISOString(),
        });
    } catch {
        // Ignore abort persistence errors
    }
    await Actor.exit();
});

try {
    const input = (await Actor.getInput()) || {};
    const {
        productUrls = [],
        itemIds = [],
        searchKeywords = [],
        sortBy = 'best_seller',
        maxProducts = 40,
        proxyConfiguration,
    } = input;

    log.info('Starting Walmart Scraper (Live Prices, Rollbacks & UPC)...');

    let proxyConfig = null;
    let proxyTransportBlocked = false;
    let isUnblockerProxy = false;

    if (proxyConfiguration) {
        try {
            proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
            if (proxyConfig) {
                if (Array.isArray(proxyConfig.groups) && proxyConfig.groups.some((g) => /UNBLOCKER/i.test(String(g)))) {
                    isUnblockerProxy = true;
                }
                log.info('Apify Proxy enabled', {
                    groups: proxyConfig.groups || [],
                    countryCode: proxyConfig.countryCode || null,
                    isManInTheMiddle: Boolean(proxyConfig.isManInTheMiddle),
                    isUnblockerProxy,
                });
            }
        } catch (proxyErr) {
            log.warning(`Proxy initialization failed (${proxyErr.message}); continuing with direct connection.`);
        }
    }

    const pushDataWithRetry = async (records) => {
        const cleanBatch = Array.isArray(records) ? records.map(sanitizeRecord).filter(Boolean) : [];
        if (cleanBatch.length === 0) return;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                await Actor.pushData(cleanBatch);
                return;
            } catch (pushErr) {
                if (attempt === 2) throw pushErr;
                log.warning(`Transient dataset push error (${pushErr.message}); retrying...`);
                await new Promise((r) => setTimeout(r, 1500));
            }
        }
    };

    const getFreshProxyUrl = async () => {
        if (!proxyConfig || proxyTransportBlocked) return undefined;
        try {
            return await proxyConfig.newUrl();
        } catch {
            return undefined;
        }
    };

    const fetchHtmlWithHttp = async (url) => {
        try {
            new URL(url);
        } catch {
            return { html: '', statusCode: 0, pageState: { state: 'invalid_url', reason: `Invalid URL: ${url}` } };
        }

        const maxAttempts = proxyConfig && !proxyTransportBlocked && !isUnblockerProxy ? 2 : 1;
        let lastRes = { html: '', statusCode: 0, pageState: { state: 'transport_error', reason: 'HTTP request failed' } };

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const attemptProxyUrl = await getFreshProxyUrl();
            const usingUnblocker = isUnblockerProxy || /UNBLOCKER/i.test(attemptProxyUrl || '');
            try {
                const response = await gotScraping({
                    url,
                    proxyUrl: attemptProxyUrl,
                    headers: {
                        'accept-language': 'en-US,en;q=0.9',
                        'accept-encoding': 'gzip, deflate, br',
                        'sec-fetch-site': 'none',
                    },
                    headerGeneratorOptions: {
                        browsers: [{ name: 'chrome' }],
                        operatingSystems: ['windows', 'linux'],
                    },
                    https: { rejectUnauthorized: false },
                    http2: !usingUnblocker,
                    sessionToken: {},
                    retry: { limit: usingUnblocker ? 0 : 1 },
                    timeout: { request: usingUnblocker ? 65000 : 25000 },
                    throwHttpErrors: false,
                });

                if (isProxyTransportError(response.statusCode)) {
                    log.warning(`HTTP proxy transport status ${response.statusCode}; switching to direct connection for remaining requests.`);
                    proxyTransportBlocked = true;
                    continue;
                }

                const html = response.body || '';
                const pageState = detectWalmartPageState(html, response.statusCode);
                lastRes = { html, statusCode: response.statusCode, pageState };
                if (pageState.state !== 'antibot_challenge') {
                    return lastRes;
                }
            } catch (err) {
                if (isProxyTransportError(err)) {
                    log.warning(`Proxy transport error (${err.message}); switching to direct connection.`);
                    proxyTransportBlocked = true;
                }
                lastRes = { html: '', statusCode: 0, pageState: { state: 'transport_error', reason: err.message } };
            }
        }
        return lastRes;
    };

    const safePageContent = async (page) => {
        for (let i = 0; i < 3; i++) {
            try {
                return await page.content();
            } catch (err) {
                if (i === 2) throw err;
                await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
                await page.waitForTimeout(500);
            }
        }
        return '';
    };

    const runPlaywrightOnce = async (url, mode = 'product', attemptProxyUrl = undefined) => {
        const hasXvfbDisplay = process.platform === 'linux' && Boolean(process.env.DISPLAY);
        const launchOptions = {
            headless: !hasXvfbDisplay,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-webgl',
                '--disable-3d-apis',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--no-first-run',
                '--mute-audio',
                '--ignore-certificate-errors',
                '--ignore-certificate-errors-spki-list',
                '--disable-blink-features=AutomationControlled',
            ],
        };
        if (attemptProxyUrl) {
            launchOptions.proxy = parsePlaywrightProxy(attemptProxyUrl);
        }

        const browser = await chromium.launch(launchOptions);
        activeBrowser = browser;
        try {
            const browserVersion = browser.version() || '147.0.0.0';
            const cleanUserAgent = `Mozilla/5.0 (${process.platform === 'linux' ? 'X11; Linux x86_64' : 'Windows NT 10.0; Win64; x64'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion} Safari/537.36`;

            const context = await browser.newContext({
                ignoreHTTPSErrors: true,
                userAgent: cleanUserAgent,
                locale: 'en-US',
                viewport: { width: 1366, height: 768 },
                extraHTTPHeaders: {
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': 'https://www.walmart.com/',
                },
            });

            await context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            });

            const page = await context.newPage();
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (['image', 'media', 'font'].includes(type)) {
                    return route.abort();
                }
                return route.continue();
            });

            const capturedJsonPayloads = [];
            page.on('response', async (resp) => {
                const rUrl = resp.url();
                const ct = resp.headers()['content-type'] || '';
                if (ct.includes('json') && /(orchestra|snb|graphql|search|item|__next\/data)/i.test(rUrl)) {
                    try {
                        const data = await resp.json();
                        if (data && typeof data === 'object') capturedJsonPayloads.push(data);
                    } catch {
                        // Ignore streamed/non-JSON payloads
                    }
                }
            });

            const gotoTimeoutMs = isUnblockerProxy || /UNBLOCKER/i.test(attemptProxyUrl || '') ? 65000 : 40000;
            const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: gotoTimeoutMs });
            const statusCode = resp ? resp.status() : 200;

            const waitSel = mode === 'search'
                ? '[data-item-id], [data-automation-id="product-title"], a[href*="/ip/"], #px-captcha, [aria-label*="Robot or human"]'
                : 'h1, script#__NEXT_DATA__, #px-captcha, [aria-label*="Robot or human"]';
            await page.waitForSelector(waitSel, { timeout: 12000 }).catch(() => {});
            await page.waitForTimeout(1000);

            const html = await safePageContent(page);
            const domData = mode === 'search'
                ? await page.evaluate(() => {
                    const out = [];
                    const seen = new Set();
                    const pushCard = (itemIdRaw, hrefRaw, titleRaw, cardText, thumbRaw) => {
                        const href = (hrefRaw || '').split('?')[0].split('#')[0];
                        if (!href.includes('/ip/') && !itemIdRaw) return;
                        const idFromHref = href.match(/\/ip\/(?:[^/]+\/)?(\d{6,14})/)?.[1] || null;
                        const itemId = itemIdRaw || idFromHref;
                        const fullUrl = href ? (href.startsWith('http') ? href : `https://www.walmart.com${href}`) : `https://www.walmart.com/ip/${itemId}`;
                        const title = (titleRaw || '').trim();
                        if (!title || title.length < 4 || seen.has(fullUrl)) return;
                        seen.add(fullUrl);
                        const priceHit = (cardText || '').match(/\$\s*[\d,]+(?:\.\d{2})?/);
                        const ratingHit = (cardText || '').match(/([0-5]\.\d)\s*(?:out of 5|stars?)/i);
                        out.push({
                            itemId,
                            title,
                            priceText: priceHit ? priceHit[0] : null,
                            ratingText: ratingHit ? ratingHit[1] : null,
                            thumbnail: thumbRaw && thumbRaw.startsWith('//') ? `https:${thumbRaw}` : thumbRaw,
                            url: fullUrl,
                        });
                    };

                    for (const card of document.querySelectorAll('[data-item-id]')) {
                        const itemId = card.getAttribute('data-item-id');
                        const link = card.querySelector('a[href*="/ip/"]');
                        const titleEl = card.querySelector('[data-automation-id="product-title"], .product-title-link span');
                        const imgEl = card.querySelector('img[data-testid="productTileImage"], img');
                        const ratingEl = card.querySelector('[data-testid="product-ratings"]');
                        pushCard(
                            itemId,
                            link?.getAttribute('href'),
                            titleEl?.innerText || link?.innerText,
                            `${card.innerText || ''} ${ratingEl?.getAttribute('aria-label') || ''}`,
                            imgEl?.getAttribute('data-src') || imgEl?.src || null
                        );
                    }

                    if (out.length === 0) {
                        for (const a of Array.from(document.querySelectorAll('a[href*="/ip/"]')).slice(0, 120)) {
                            const box = a.closest('[data-testid], li, article, div') || a.parentElement;
                            const img = box ? box.querySelector('img') : null;
                            pushCard(null, a.getAttribute('href'), a.innerText || a.getAttribute('aria-label') || img?.alt, box?.innerText || '', img?.src || null);
                        }
                    }
                    return out;
                }).catch(() => [])
                : [];

            const pageState = detectWalmartPageState(html, statusCode);
            return { html, statusCode, capturedJsonPayloads, domData, pageState };
        } finally {
            if (activeBrowser === browser) activeBrowser = null;
            await browser.close().catch(() => {});
        }
    };

    const fetchWithPlaywright = async (url, mode = 'product', extractCheck = null) => {
        try {
            new URL(url);
        } catch {
            return { html: '', statusCode: 0, capturedJsonPayloads: [], domData: [], pageState: { state: 'invalid_url', reason: `Invalid URL: ${url}` } };
        }

        const maxPwAttempts = proxyConfig && !proxyTransportBlocked && !isUnblockerProxy ? 2 : 1;
        let lastRes = { html: '', statusCode: 0, capturedJsonPayloads: [], domData: [], pageState: { state: 'browser_error', reason: 'Playwright failed' } };

        for (let pwAttempt = 1; pwAttempt <= maxPwAttempts; pwAttempt++) {
            const pwProxyUrl = await getFreshProxyUrl();
            try {
                const res = await runPlaywrightOnce(url, mode, pwProxyUrl);
                lastRes = res;
                const hasItems = typeof extractCheck === 'function' ? extractCheck(res) : false;
                if (hasItems || res.pageState?.state === 'unavailable') {
                    return res;
                }
                if (pwAttempt < maxPwAttempts) {
                    log.warning(`Playwright attempt ${pwAttempt}/${maxPwAttempts} yielded state=${res.pageState?.state} (${res.pageState?.reason}). Retrying with a fresh proxy IP...`);
                    await new Promise((r) => setTimeout(r, 1200));
                }
            } catch (pwErr) {
                if (isProxyTransportError(pwErr)) {
                    proxyTransportBlocked = true;
                }
                lastRes = { html: '', statusCode: 0, capturedJsonPayloads: [], domData: [], pageState: { state: 'browser_error', reason: pwErr.message } };
                if (pwAttempt < maxPwAttempts) {
                    log.warning(`Playwright attempt ${pwAttempt}/${maxPwAttempts} failed (${pwErr.message}). Retrying...`);
                    await new Promise((r) => setTimeout(r, 1200));
                }
            }
        }
        return lastRes;
    };

    const extractSearchResultsFromPw = (pwRes) => {
        let items = parseWalmartSearchHtml(pwRes.html);

        if (items.length === 0 && Array.isArray(pwRes.capturedJsonPayloads) && pwRes.capturedJsonPayloads.length > 0) {
            const merged = [];
            const seen = new Set();
            for (const payload of pwRes.capturedJsonPayloads) {
                for (const it of extractSearchItemsFromJson(payload)) {
                    const key = it.itemId || it.url;
                    if (key && seen.has(key)) continue;
                    if (key) seen.add(key);
                    merged.push(it);
                }
            }
            items = merged;
        }

        if (items.length === 0 && Array.isArray(pwRes.domData) && pwRes.domData.length > 0) {
            items = pwRes.domData.map((d) => ({
                itemId: d.itemId || extractWalmartItemId(d.url),
                title: d.title,
                price: parseWalmartPrice(d.priceText),
                currency: 'USD',
                rating: parseWalmartRating(d.ratingText),
                thumbnail: d.thumbnail,
                url: d.url,
                scrapedAt: new Date().toISOString(),
            }));
        }
        return items;
    };

    // Normalize targets & route plain keywords accidentally pasted into productUrls cleanly to search
    const urlSet = new Set();
    const keywordSet = new Set(
        (Array.isArray(searchKeywords) ? searchKeywords : [])
            .map((k) => (typeof k === 'string' ? k.trim() : ''))
            .filter(Boolean)
    );

    if (Array.isArray(productUrls)) {
        for (const u of productUrls) {
            const rawStr = (typeof u === 'string' ? u : u?.url || '')?.trim();
            if (!rawStr) continue;
            const normalized = /^(?:www\.)?walmart\.com\//i.test(rawStr) ? `https://${rawStr}` : rawStr;
            let parsed = null;
            try {
                parsed = new URL(normalized);
            } catch {
                parsed = null;
            }
            if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
                urlSet.add(parsed.toString());
            } else {
                log.warning(`Ignoring non-URL entry in "productUrls" ("${rawStr}") and routing it to keyword search instead.`);
                keywordSet.add(rawStr);
            }
        }
    }

    if (Array.isArray(itemIds)) {
        for (const rawId of itemIds) {
            const str = String(rawId || '').trim();
            if (!str) continue;
            const id = extractWalmartItemId(str);
            if (id) {
                urlSet.add(`https://www.walmart.com/ip/${id}`);
            } else {
                log.warning(`Ignoring invalid Walmart itemId "${str}"`);
            }
        }
    }

    if (urlSet.size === 0 && keywordSet.size === 0) {
        keywordSet.add('wireless earbuds');
    }

    const effectiveProductUrls = [...urlSet];
    const effectiveSearchKeywords = [...keywordSet];

    // 1. Process Direct Product URLs & Item IDs
    if (effectiveProductUrls.length > 0) {
        log.info(`Scraping ${effectiveProductUrls.length} direct Walmart product URLs...`);

        for (const targetUrl of effectiveProductUrls) {
            log.info(`Fetching Walmart product: ${targetUrl}`);
            let product = null;

            const httpRes = await fetchHtmlWithHttp(targetUrl);
            if (httpRes.pageState.state === 'ok') {
                product = parseWalmartProductHtml(httpRes.html, targetUrl);
            }

            let finalState = product?.title ? 'ok' : httpRes.pageState.state;
            let finalReason = product?.title ? 'OK' : httpRes.pageState.reason;

            if ((!product || !product.title) && httpRes.pageState.state !== 'unavailable' && httpRes.pageState.state !== 'invalid_url') {
                log.info(`Using browser fallback for Walmart item: ${targetUrl} (HTTP state=${finalState}, len=${httpRes.html?.length || 0}, reason=${finalReason})...`);
                const pwRes = await fetchWithPlaywright(
                    targetUrl,
                    'product',
                    (res) => Boolean(parseWalmartProductHtml(res.html, targetUrl)?.title)
                );
                product = parseWalmartProductHtml(pwRes.html, targetUrl);
                finalState = product?.title ? 'ok' : pwRes.pageState?.state;
                finalReason = product?.title ? 'OK' : pwRes.pageState?.reason;
            }

            if (product && product.title) {
                await pushDataWithRetry([product]);
                totalProductsScraped++;
                if (product.inStock) inStockCount++;
                if (product.priceType === 'Rollback') rollbackDealsCount++;
                diagnostics.push({ target: targetUrl, mode: 'product', state: 'ok', itemsExtracted: 1 });
                log.info(`[${totalProductsScraped}] Scraped: "${product.title.slice(0, 40)}..." | Price: $${product.price ?? 'N/A'} | Deal: ${product.priceType}`);
            } else {
                diagnostics.push({ target: targetUrl, mode: 'product', state: finalState, reason: finalReason, itemsExtracted: 0 });
                log.warning(`Could not extract valid item from ${targetUrl} (state=${finalState}: ${finalReason})`);
            }

            await new Promise((r) => setTimeout(r, 1000));
        }
    }

    // 2. Process Search Keywords
    if (effectiveSearchKeywords.length > 0) {
        log.info(`Searching Walmart for ${effectiveSearchKeywords.length} keyword(s)...`);

        for (const keyword of effectiveSearchKeywords) {
            log.info(`Searching Walmart for: "${keyword}" (sort: ${sortBy}, max: ${maxProducts})`);
            const baseSearchUrl = `https://www.walmart.com/search?q=${encodeURIComponent(keyword)}&sort=${encodeURIComponent(sortBy)}`;

            try {
                const collected = [];
                const seenKeys = new Set();
                let lastState = 'ok';
                let lastReason = 'OK';
                const maxPages = Math.min(5, Math.max(1, Math.ceil(maxProducts / 40)));

                for (let pageNum = 1; pageNum <= maxPages && collected.length < maxProducts; pageNum++) {
                    const searchUrl = pageNum === 1 ? baseSearchUrl : `${baseSearchUrl}&page=${pageNum}`;
                    const httpRes = await fetchHtmlWithHttp(searchUrl);
                    let pageItems = parseWalmartSearchHtml(httpRes.html);
                    lastState = pageItems.length > 0 ? 'ok' : httpRes.pageState.state;
                    lastReason = pageItems.length > 0 ? 'OK' : httpRes.pageState.reason;

                    if (pageItems.length === 0) {
                        log.info(`Using browser fallback for Walmart search "${keyword}" page ${pageNum} (HTTP state=${lastState}, len=${httpRes.html?.length || 0}, reason=${lastReason})...`);
                        const pwRes = await fetchWithPlaywright(
                            searchUrl,
                            'search',
                            (res) => extractSearchResultsFromPw(res).length > 0
                        );
                        pageItems = extractSearchResultsFromPw(pwRes);
                        lastState = pageItems.length > 0 ? 'ok' : (pwRes.pageState?.state || lastState);
                        lastReason = pageItems.length > 0 ? 'OK' : (pwRes.pageState?.reason || lastReason);
                    }

                    if (pageItems.length === 0) break;

                    let addedOnPage = 0;
                    for (const item of pageItems) {
                        const key = item.itemId || item.url;
                        if (key && seenKeys.has(key)) continue;
                        if (key) seenKeys.add(key);
                        collected.push(item);
                        addedOnPage++;
                        if (collected.length >= maxProducts) break;
                    }
                    if (addedOnPage === 0) break;
                }

                const sliced = collected.slice(0, maxProducts).map((item) => ({ ...item, searchKeyword: keyword }));
                if (sliced.length > 0) {
                    await pushDataWithRetry(sliced);
                    for (const item of sliced) {
                        totalProductsScraped++;
                        if (item.inStock) inStockCount++;
                        if (item.priceType === 'Rollback') rollbackDealsCount++;
                    }
                }

                diagnostics.push({
                    target: keyword,
                    mode: 'search',
                    state: sliced.length > 0 ? 'ok' : lastState,
                    reason: sliced.length > 0 ? 'OK' : (lastReason || `No search results parsed for "${keyword}"`),
                    itemsExtracted: sliced.length,
                });

                if (sliced.length > 0) {
                    log.info(`Extracted ${sliced.length} search results for "${keyword}"`);
                } else {
                    log.warning(`Extracted 0 search results for "${keyword}" (state=${lastState}: ${lastReason})`);
                }
            } catch (searchErr) {
                diagnostics.push({ target: keyword, mode: 'search', state: 'error', reason: searchErr.message, itemsExtracted: 0 });
                log.error(`Error searching Walmart for "${keyword}": ${searchErr.message}`);
            }
        }
    }

    await closeActiveBrowser();

    const summary = {
        totalProductsScraped,
        inStockCount,
        rollbackDealsCount,
        diagnostics,
        status: totalProductsScraped > 0 ? 'SUCCEEDED' : 'FAILED',
        scrapedAt: new Date().toISOString(),
    };

    await Actor.setValue('OUTPUT', summary);
    if (totalProductsScraped === 0) {
        const lastDiag = diagnostics[diagnostics.length - 1];
        const hint = lastDiag?.reason ? ` Last diagnostic: ${lastDiag.state} (${lastDiag.reason}).` : '';
        await Actor.fail(`Extracted 0 products.${hint} Verify target URLs, keywords, or enable US RESIDENTIAL / UNBLOCKER Proxy.`);
    }
    log.info(`Walmart Scraping finished successfully! Total items: ${totalProductsScraped}`);
} catch (err) {
    await closeActiveBrowser();
    log.error(`Fatal execution error: ${err.message}`, { stack: err.stack });
    await Actor.setValue('OUTPUT', { status: 'FAILED', error: err.message, diagnostics });
    await Actor.fail(err.message);
} finally {
    await closeActiveBrowser();
    await Actor.exit();
}
