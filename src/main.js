import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { chromium } from 'playwright';
import {
    extractWalmartItemId,
    parseWalmartProductHtml,
    parseWalmartSearchHtml,
} from './extractors.js';

function sanitizeRecord(obj) {
    if (Array.isArray(obj)) return obj.map((item) => sanitizeRecord(item));
    if (!obj || typeof obj !== 'object') return obj;
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== null && v !== undefined && !(typeof v === 'number' && !Number.isFinite(v))) {
            clean[k] = Array.isArray(v)
                ? v.map((item) => (item && typeof item === 'object' ? sanitizeRecord(item) : item))
                : v && typeof v === 'object' && !(v instanceof Date)
                    ? sanitizeRecord(v)
                    : v;
        }
    }
    return clean;
}

function isProxyTransportError(errOrStatus) {
    const msg = String(errOrStatus?.message || errOrStatus || '');
    return errOrStatus === 597 || errOrStatus === 407 || /597|UPSTREAM407|407|Proxy responded with|tunneling socket/i.test(msg);
}

await Actor.init();

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

    // Setup Proxy
    let proxyConfig = null;
    let proxyUrl = undefined;
    if (proxyConfiguration) {
        try {
            proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
            if (proxyConfig) {
                proxyUrl = await proxyConfig.newUrl();
                log.info('Apify Proxy enabled');
            }
        } catch (proxyErr) {
            log.warning(`Proxy initialization failed (${proxyErr.message}); continuing with direct connection.`);
        }
    }

    const rotateOrDisableProxy = async (err) => {
        if (!isProxyTransportError(err)) return;
        if (proxyConfig) {
            try {
                proxyUrl = await proxyConfig.newUrl();
                log.warning('Rotated Apify Proxy session after upstream proxy transport error.');
                return;
            } catch {
                // Fall through to disable proxy
            }
        }
        proxyUrl = undefined;
        log.warning('Disabled broken proxy session; falling back to direct connection.');
    };

    let totalProductsScraped = 0;
    let inStockCount = 0;
    let rollbackDealsCount = 0;

    // Browser Helper for Anti-Bot Fallback
    let browser = null;
    const getBrowser = async () => {
        if (!browser) {
            const launchOptions = {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                ],
            };
            if (proxyUrl) {
                try {
                    const u = new URL(proxyUrl);
                    launchOptions.proxy = {
                        server: `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`,
                        ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
                        ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
                    };
                } catch {
                    launchOptions.proxy = { server: proxyUrl };
                }
            }
            browser = await chromium.launch(launchOptions);
        }
        return browser;
    };

    // 1. Collect target URLs from productUrls and itemIds
    const allUrls = new Set();
    if (Array.isArray(productUrls)) {
        for (const u of productUrls) {
            const str = typeof u === 'string' ? u : u?.url;
            if (str) allUrls.add(str);
        }
    }
    if (Array.isArray(itemIds)) {
        for (const id of itemIds) {
            if (id) allUrls.add(`https://www.walmart.com/ip/${id}`);
        }
    }
    if (allUrls.size === 0 && (!Array.isArray(searchKeywords) || searchKeywords.length === 0)) {
        allUrls.add('https://www.walmart.com/ip/123456789');
    }

    // Process Direct URLs
    if (allUrls.size > 0) {
        log.info(`Scraping ${allUrls.size} direct Walmart product URLs...`);

        for (const targetUrl of allUrls) {
            log.info(`Fetching Walmart product: ${targetUrl}`);
            let product = null;

            // Strategy A: gotScraping
            try {
                const response = await gotScraping({
                    url: targetUrl,
                    proxyUrl,
                    headers: {
                        'accept-language': 'en-US,en;q=0.9',
                        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                    },
                    timeout: { request: 30000 },
                });

                const html = response.body;
                if (!html.includes('Blocked') && !html.includes('robot or human')) {
                    product = parseWalmartProductHtml(html, targetUrl);
                }
            } catch (err) {
                await rotateOrDisableProxy(err);
                log.debug(`gotScraping error for ${targetUrl}: ${err.message}`);
            }

            // Strategy B: Browser fallback
            if (!product || !product.title) {
                try {
                    log.info(`Using browser fallback for Walmart item: ${targetUrl}...`);
                    const b = await getBrowser();
                    const page = await b.newPage();
                    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
                    await page.waitForTimeout(2000);

                    const html = await page.content();
                    product = parseWalmartProductHtml(html, targetUrl);
                    await page.close();
                } catch (bErr) {
                    await rotateOrDisableProxy(bErr);
                    log.warning(`Browser fallback error for ${targetUrl}: ${bErr.message}`);
                }
            }

            if (product && product.title) {
                await Actor.pushData(sanitizeRecord(product));
                totalProductsScraped++;
                if (product.inStock) inStockCount++;
                if (product.priceType === 'Rollback') rollbackDealsCount++;

                log.info(`[${totalProductsScraped}] Scraped: "${product.title.slice(0, 40)}..." | Price: $${product.price ?? 'N/A'} | Deal: ${product.priceType}`);
            } else {
                log.warning(`Could not extract valid item from: ${targetUrl}`);
            }

            // Polite delay
            await new Promise((r) => setTimeout(r, 1500));
        }
    }

    // 2. Process Search Keywords
    if (Array.isArray(searchKeywords) && searchKeywords.length > 0) {
        log.info(`Searching Walmart for ${searchKeywords.length} keywords...`);

        for (const keyword of searchKeywords) {
            log.info(`Searching Walmart for: "${keyword}" (sort: ${sortBy}, max: ${maxProducts})`);

            const searchUrl = `https://www.walmart.com/search?q=${encodeURIComponent(keyword)}&sort=${sortBy}`;

            try {
                let html = null;

                try {
                    const response = await gotScraping({
                        url: searchUrl,
                        proxyUrl,
                        headers: {
                            'accept-language': 'en-US,en;q=0.9',
                            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                        },
                        timeout: { request: 30000 },
                    });
                    html = response.body;
                } catch (err) {
                    await rotateOrDisableProxy(err);
                    log.debug(`Direct search error: ${err.message}`);
                }

                if (!html || html.includes('Blocked') || html.includes('robot or human')) {
                    const b = await getBrowser();
                    const page = await b.newPage();
                    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
                    await page.waitForTimeout(3000);
                    html = await page.content();
                    await page.close();
                }

                const results = parseWalmartSearchHtml(html);
                const sliced = results.slice(0, maxProducts);

                for (const item of sliced) {
                    item.searchKeyword = keyword;
                    await Actor.pushData(sanitizeRecord(item));
                    totalProductsScraped++;
                }

                log.info(`Extracted ${sliced.length} search results for "${keyword}"`);

            } catch (searchErr) {
                log.error(`Error searching Walmart for "${keyword}": ${searchErr.message}`);
            }
        }
    }

    if (browser) {
        await browser.close();
    }

    // Save final executive summary
    const summary = {
        totalProductsScraped,
        inStockCount,
        rollbackDealsCount,
        status: totalProductsScraped > 0 ? 'SUCCEEDED' : 'FAILED',
        scrapedAt: new Date().toISOString(),
    };

    await Actor.setValue('OUTPUT', summary);
    if (totalProductsScraped === 0) {
        await Actor.fail('Extracted 0 products. Verify target URLs, keywords, or proxy configuration.');
    }
    log.info(`Walmart Scraping finished successfully! Total items: ${totalProductsScraped}`);

} catch (err) {
    log.error(`Fatal execution error: ${err.message}`, { stack: err.stack });
    await Actor.setValue('OUTPUT', { status: 'FAILED', error: err.message });
    await Actor.fail(err.message);
} finally {
    await Actor.exit();
}
