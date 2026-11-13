/**
 * Walmart Product & Search Extraction Handlers
 */

function decodeHtmlEntities(str) {
    if (!str || typeof str !== 'string') return str;
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Extract numerical Walmart Item ID from URL or plain ID string
 */
export function extractWalmartItemId(url) {
    if (!url || typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (/^\d{6,14}$/.test(trimmed)) return trimmed;
    const match = trimmed.match(/\/ip\/(?:[^/]+\/)?(\d{6,14})/i) || trimmed.match(/itemId=(\d{6,14})/i);
    return match ? match[1] : null;
}

/**
 * Clean numeric price from string or number
 */
export function parseWalmartPrice(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (!raw || typeof raw !== 'string') return null;
    const firstPart = raw.split(/\s*-\s*/)[0];
    const cleaned = firstPart.replace(/[^0-9.,]/g, '').trim();
    if (!cleaned) return null;
    if (cleaned.includes(',') && !cleaned.includes('.')) {
        const val = parseFloat(cleaned.replace(',', '.'));
        return Number.isFinite(val) ? val : null;
    }
    const val = parseFloat(cleaned.replace(/,/g, ''));
    return Number.isFinite(val) ? val : null;
}

/**
 * Clean star rating
 */
export function parseWalmartRating(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (!raw || typeof raw !== 'string') return null;
    const match = raw.replace(',', '.').match(/([0-5]\.[0-9]|[0-5])/);
    return match ? parseFloat(match[1]) : null;
}

/**
 * Clean review count
 */
export function parseWalmartReviewsCount(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : 0;
    if (!raw || typeof raw !== 'string') return 0;
    const digits = raw.replace(/[^\d]/g, '');
    return digits ? parseInt(digits, 10) : 0;
}

/**
 * Detect whether a Walmart response is a PerimeterX/anti-bot gate, unavailable product, or valid page
 */
export function detectWalmartPageState(html, statusCode = 200) {
    if (statusCode === 404 || statusCode === 410) {
        return { state: 'unavailable', reason: `HTTP ${statusCode} (Walmart item not found)` };
    }
    if (statusCode === 403 || statusCode === 412 || statusCode === 429 || statusCode === 503) {
        return {
            state: 'antibot_challenge',
            reason: `HTTP ${statusCode} Walmart PerimeterX anti-bot gate (US RESIDENTIAL or UNBLOCKER proxy recommended)`,
        };
    }
    if (statusCode >= 400) {
        return { state: 'http_error', reason: `HTTP ${statusCode}` };
    }
    if (!html || typeof html !== 'string' || html.trim().length < 20) {
        return { state: 'empty_body', reason: 'Empty or truncated HTML response' };
    }

    const rawLower = html.toLowerCase();
    const visibleLower = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .toLowerCase();

    const hasNextDataPayload =
        rawLower.includes('__next_data__') &&
        (rawLower.includes('"searchresult"') || rawLower.includes('"itemstacks"') || rawLower.includes('"usitemid"'));
    const hasWalmartSignals =
        hasNextDataPayload ||
        /data-item-id="[0-9a-z-]{6,}"/i.test(html) ||
        /\/ip\/(?:[^/"'\s]+\/)?\d{6,}/i.test(html);

    if (
        visibleLower.includes('robot or human') ||
        visibleLower.includes('verify your identity') ||
        visibleLower.includes('access to this page has been denied') ||
        visibleLower.includes('press & hold') ||
        (!hasWalmartSignals && (
            rawLower.includes('robot or human') ||
            rawLower.includes('px-captcha') ||
            rawLower.includes('/blocked?') ||
            rawLower.includes('_pxhd') ||
            rawLower.includes('perimeterx')
        ))
    ) {
        return {
            state: 'antibot_challenge',
            reason: 'Walmart PerimeterX ("Robot or human?") gate detected; US RESIDENTIAL or UNBLOCKER proxy required',
        };
    }

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const pageTitle = titleMatch ? decodeHtmlEntities(titleMatch[1]) : '';
    if (
        /this page could not be found|page not found|error page/i.test(pageTitle) ||
        (/could not find this page|no longer available/i.test(visibleLower) && !hasWalmartSignals)
    ) {
        return { state: 'unavailable', reason: pageTitle || 'Product Not Found' };
    }

    if (html.trim().length < 150) {
        return { state: 'empty_body', reason: 'Empty or near-empty HTML response' };
    }
    return { state: 'ok', reason: pageTitle || 'OK' };
}

function normalizeWalmartUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    const clean = rawUrl.split('?')[0].split('#')[0].trim();
    if (clean.startsWith('http://') || clean.startsWith('https://')) return clean;
    if (clean.startsWith('//')) return `https:${clean}`;
    if (clean.startsWith('/')) return `https://www.walmart.com${clean}`;
    return null;
}

/**
 * Recursively collect normalized search product entries from Walmart __NEXT_DATA__ or GraphQL JSON payloads
 */
export function extractSearchItemsFromJson(payload) {
    const results = [];
    if (!payload || typeof payload !== 'object') return results;

    const seenIds = new Set();
    const seenUrls = new Set();
    const queue = [payload];
    const visited = new Set();

    while (queue.length > 0) {
        const node = queue.shift();
        if (!node || typeof node !== 'object' || visited.has(node)) continue;
        visited.add(node);

        if (Array.isArray(node)) {
            for (const el of node) {
                if (el && typeof el === 'object') queue.push(el);
            }
            continue;
        }

        const candidateId = node.usItemId || (typeof node.id === 'string' && /^\d{6,14}$/.test(node.id) ? node.id : null);
        const candidateTitle = typeof node.name === 'string' ? node.name : typeof node.title === 'string' ? node.title : null;
        const candidateUrl = normalizeWalmartUrl(node.canonicalUrl || node.productPageUrl || (candidateId ? `/ip/${candidateId}` : null));

        if (candidateId && candidateTitle && candidateTitle.length > 3 && !seenIds.has(String(candidateId)) && !seenUrls.has(candidateUrl)) {
            const pInfo = node.priceInfo || {};
            const currentPrice = pInfo.currentPrice?.price ?? node.price ?? pInfo.itemPrice?.price ?? null;
            const wasPrice = pInfo.wasPrice?.price ?? pInfo.linePrice ?? node.wasPrice ?? null;
            const badgeText = node.badges?.flags?.[0]?.text || node.badges?.tags?.[0]?.text || node.badge || null;
            let priceType = pInfo.priceType || 'Regular';
            if (typeof badgeText === 'string' && /rollback/i.test(badgeText)) priceType = 'Rollback';
            else if (typeof badgeText === 'string' && /clearance/i.test(badgeText)) priceType = 'Clearance';
            else if (typeof badgeText === 'string' && /reduced/i.test(badgeText)) priceType = 'Reduced price';
            else if (wasPrice && currentPrice && Number(wasPrice) > Number(currentPrice)) priceType = 'Rollback';

            const thumb = node.imageInfo?.thumbnailUrl || node.image || node.thumbnailUrl || null;
            const avail = node.availabilityStatusV2?.value || node.availabilityStatus || '';
            const inStock = avail ? !/out_of_stock|out of stock/i.test(String(avail)) : true;

            seenIds.add(String(candidateId));
            if (candidateUrl) seenUrls.add(candidateUrl);

            results.push({
                itemId: String(candidateId),
                title: decodeHtmlEntities(candidateTitle),
                price: parseWalmartPrice(currentPrice),
                originalPrice: parseWalmartPrice(wasPrice),
                currency: pInfo.currentPrice?.currencyUnit || 'USD',
                priceType,
                rating: parseWalmartRating(node.averageRating ?? node.rating?.averageRating),
                reviewsCount: parseWalmartReviewsCount(node.numberOfReviews ?? node.totalReviewCount),
                inStock,
                stockStatus: inStock ? 'In stock' : 'Out of stock',
                brand: typeof node.brand === 'string' ? node.brand : node.brand?.name || null,
                sellerName: node.sellerName || node.fulfillmentBadge || 'Walmart.com',
                badge: typeof badgeText === 'string' ? badgeText : null,
                thumbnail: typeof thumb === 'string' && thumb.startsWith('//') ? `https:${thumb}` : thumb,
                url: candidateUrl || `https://www.walmart.com/ip/${candidateId}`,
                scrapedAt: new Date().toISOString(),
            });
            continue;
        }

        for (const val of Object.values(node)) {
            if (val && typeof val === 'object') queue.push(val);
        }
    }

    return results;
}

/**
 * Parse product details from Walmart HTML (supports __NEXT_DATA__, JSON-LD & DOM)
 */
export function parseWalmartProductHtml(html, url = '') {
    if (!html || detectWalmartPageState(html, 200).state === 'antibot_challenge') return null;

    const itemId = extractWalmartItemId(url);

    // 1. Check __NEXT_DATA__ state
    try {
        const nextDataMatch = html.match(/<script\b[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
        if (nextDataMatch) {
            const parsed = JSON.parse(nextDataMatch[1]);
            const p = parsed?.props?.pageProps?.initialData?.data?.product;
            if (p && (p.name || p.usItemId)) {
                const currentPrice = p.priceInfo?.currentPrice?.price ?? null;
                const wasPrice = p.priceInfo?.wasPrice?.price ?? null;
                const priceType = p.priceInfo?.priceType || (wasPrice ? 'Rollback' : 'Regular');

                const images = (p.imageInfo?.allImages || []).map((img) => img.url).filter(Boolean);
                const thumbnail = p.imageInfo?.thumbnailUrl || images[0] || null;

                return {
                    itemId: p.usItemId || itemId,
                    title: decodeHtmlEntities(p.name || ''),
                    price: parseWalmartPrice(currentPrice),
                    originalPrice: parseWalmartPrice(wasPrice),
                    currency: p.priceInfo?.currentPrice?.currencyUnit || 'USD',
                    priceType,
                    rating: parseWalmartRating(p.averageRating),
                    reviewsCount: parseWalmartReviewsCount(p.totalReviewCount),
                    inStock: p.inventory?.inStock ?? true,
                    stockStatus: p.inventory?.inStock ? 'In stock' : 'Out of stock',
                    brand: p.brand || null,
                    sellerName: p.sellerName || 'Walmart.com',
                    upc: p.upc || null,
                    badge: p.badges?.flags?.[0]?.text || null,
                    description: p.shortDescription ? decodeHtmlEntities(p.shortDescription.replace(/<[^>]+>/g, ' ')) : null,
                    thumbnail,
                    images: [...new Set(images)],
                    url: normalizeWalmartUrl(p.canonicalUrl) || url,
                    scrapedAt: new Date().toISOString(),
                };
            }
        }
    } catch {
        // Fallback
    }

    // 2. Check JSON-LD Schema
    let ldData = null;
    try {
        const ldMatches = html.match(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
        if (ldMatches) {
            for (const script of ldMatches) {
                const jsonText = script.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
                const parsed = JSON.parse(jsonText);
                const candidates = Array.isArray(parsed)
                    ? parsed
                    : Array.isArray(parsed?.['@graph'])
                        ? parsed['@graph']
                        : [parsed];
                const hit = candidates.find((d) => d && (d['@type'] === 'Product' || (Array.isArray(d['@type']) && d['@type'].includes('Product'))));
                if (hit) {
                    ldData = hit;
                    break;
                }
            }
        }
    } catch {
        // Fallback
    }

    // Title
    let title = ldData?.name ? decodeHtmlEntities(ldData.name) : null;
    if (!title) {
        const titleMatch = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) ||
                           html.match(/itemprop="name"[^>]*>([\s\S]*?)<\/(?:h1|span)>/i);
        if (titleMatch) title = decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, ' '));
    }

    // Ignore false title on PerimeterX gate
    if (
        !title ||
        /robot or human|access denied|verify your identity|confirm that you.?re human|activate and hold|press.{0,6}hold|verify you are human|are you human/i.test(title)
    ) {
        return null;
    }

    // Price
    let price = ldData?.offers?.price ? parseWalmartPrice(String(ldData.offers.price)) : null;
    let originalPrice = null;

    const priceMatch = html.match(/itemprop="price"[^>]*>([^<]+)<\/span>/i) ||
                       html.match(/class="[^"]*(?:price-characteristic|price-wrap)[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/i);
    if (priceMatch && price === null) {
        price = parseWalmartPrice(priceMatch[1]);
    }

    const wasMatch = html.match(/class="[^"]*(?:was-price|w_iU)[^"]*"[^>]*>([^<]+)<\/span>/i);
    if (wasMatch) {
        originalPrice = parseWalmartPrice(wasMatch[1]);
    }

    // Rating & Reviews
    let rating = ldData?.aggregateRating?.ratingValue !== undefined
        ? parseWalmartRating(String(ldData.aggregateRating.ratingValue))
        : null;
    let reviewsCount = ldData?.aggregateRating?.reviewCount !== undefined
        ? parseWalmartReviewsCount(String(ldData.aggregateRating.reviewCount))
        : 0;

    if (rating === null) {
        const ratingMatch = html.match(/class="[^"]*rating-number[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
        if (ratingMatch) rating = parseWalmartRating(ratingMatch[1]);
    }
    if (reviewsCount === 0) {
        const revMatch = html.match(/(\d[\d,]*)\s*(?:reviews|ratings)/i);
        if (revMatch) reviewsCount = parseWalmartReviewsCount(revMatch[1]);
    }

    // In Stock
    let inStock = true;
    if (ldData?.offers?.availability) {
        inStock = !String(ldData.offers.availability).toLowerCase().includes('outofstock');
    }

    // Brand & Seller
    const brand = ldData?.brand?.name || (typeof ldData?.brand === 'string' ? ldData.brand : null);
    let sellerName = 'Walmart.com';
    const sellerMatch = html.match(/data-testid="seller-name"[^>]*>([^<]+)<\/span>/i);
    if (sellerMatch) sellerName = sellerMatch[1].trim();

    // UPC / Barcode
    const upc = ldData?.gtin12 || ldData?.gtin13 || ldData?.upc || null;

    // Images
    const images = [];
    if (Array.isArray(ldData?.image)) images.push(...ldData.image);
    else if (typeof ldData?.image === 'string') images.push(ldData.image);

    const imgBlocks = [...html.matchAll(/<img\b[^>]*data-testid="hero-image-container"[^>]*>/gi)];
    for (const m of imgBlocks) {
        const srcHit = m[0].match(/\b(?:data-src|src)="([^"]+)"/i);
        if (srcHit?.[1]) images.push(srcHit[1]);
    }

    const thumbnail = images[0] || null;

    return {
        itemId,
        title,
        price,
        originalPrice,
        currency: ldData?.offers?.priceCurrency || 'USD',
        priceType: originalPrice ? 'Rollback' : 'Regular',
        rating,
        reviewsCount,
        inStock,
        stockStatus: inStock ? 'In stock' : 'Out of stock',
        brand,
        sellerName,
        upc,
        badge: html.toLowerCase().includes('rollback') ? 'Rollback' : null,
        description: ldData?.description ? decodeHtmlEntities(ldData.description) : null,
        thumbnail,
        images: [...new Set(images)],
        url,
        scrapedAt: new Date().toISOString(),
    };
}

/**
 * Extract items from Walmart Search SERP HTML (Layer 1: __NEXT_DATA__, Layer 2: Card HTML, Layer 3: /ip/ anchors)
 */
export function parseWalmartSearchHtml(html) {
    if (!html) return [];

    // Layer 1: Embedded Next.js SSR state
    try {
        const nextDataMatch = html.match(/<script\b[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
        if (nextDataMatch) {
            const parsed = JSON.parse(nextDataMatch[1]);
            const itemStacks = parsed?.props?.pageProps?.initialData?.searchResult?.itemStacks;
            const jsonItems = extractSearchItemsFromJson(itemStacks || parsed?.props?.pageProps?.initialData?.searchResult || parsed);
            if (jsonItems.length > 0) return jsonItems;
        }
    } catch {
        // Fall through to HTML parsing
    }

    // Layer 2: Product tile HTML cards
    const results = [];
    const seenIds = new Set();
    const seenUrls = new Set();
    const cards = [...html.matchAll(/<div\b[^>]*data-item-id="([^"]+)"[\s\S]*?(?=<div\b[^>]*data-item-id=|$)/gi)];

    for (const c of cards) {
        const itemId = c[1];
        const cardHtml = c[0];

        const titleMatch =
            cardHtml.match(/data-automation-id="product-title"[^>]*>([\s\S]*?)<\/(?:span|h3|a)>/i) ||
            cardHtml.match(/class="[^"]*product-title-link[^"]*"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i) ||
            cardHtml.match(/<a\b[^>]*href="[^"]*\/ip\/[^"]+"[^>]*>([\s\S]*?)<\/a>/i);
        if (!titleMatch) continue;

        const title = decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, ' '));
        if (!title || title.length < 4) continue;

        const linkMatch = cardHtml.match(/href="((?:https?:\/\/[^"]*walmart\.com)?\/ip\/[^"]+)"/i);
        const fullUrl = normalizeWalmartUrl(linkMatch?.[1]) || `https://www.walmart.com/ip/${itemId}`;
        if (seenIds.has(itemId) || seenUrls.has(fullUrl)) continue;

        const priceMatch =
            cardHtml.match(/class="[^"]*(?:price-main|w_iU)[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/i) ||
            cardHtml.match(/\$([0-9,]+\.[0-9]{2})/);
        const price = priceMatch ? parseWalmartPrice(priceMatch[1]) : null;

        const ratingMatch = cardHtml.match(/data-testid="product-ratings"[^>]*aria-label="([0-9.,]+)\s*out of/i);
        const rating = ratingMatch ? parseWalmartRating(ratingMatch[1]) : null;

        const imgTag = cardHtml.match(/<img\b[^>]*>/i);
        const imgAttr = imgTag?.[0]?.match(/\b(?:data-src|src)="([^"]+)"/i);
        const thumbnail = imgAttr?.[1] || null;

        seenIds.add(itemId);
        seenUrls.add(fullUrl);
        results.push({
            itemId,
            title,
            price,
            currency: 'USD',
            rating,
            thumbnail,
            url: fullUrl,
            scrapedAt: new Date().toISOString(),
        });
    }

    // Layer 3: Direct /ip/ anchor fallback if tile attributes changed
    if (results.length === 0) {
        const anchorRegex = /<a\b[^>]*href="((?:https?:\/\/[^"]*walmart\.com)?\/ip\/[^"]+)"[^>]*>([\s\S]{1,600}?)<\/a>/gi;
        for (const m of html.matchAll(anchorRegex)) {
            const fullUrl = normalizeWalmartUrl(m[1]);
            if (!fullUrl) continue;
            const itemId = extractWalmartItemId(fullUrl);
            if (!itemId || seenIds.has(itemId) || seenUrls.has(fullUrl)) continue;

            const ariaMatch = m[0].match(/aria-label="([^"]{8,})"/i);
            const title = decodeHtmlEntities((ariaMatch ? ariaMatch[1] : m[2]).replace(/<[^>]+>/g, ' '));
            if (!title || title.length < 6 || /skip to|sign in|department|view details/i.test(title)) continue;

            const snippet = html.slice(Math.max(0, (m.index || 0) - 200), Math.min(html.length, (m.index || 0) + 900));
            const priceMatch = snippet.match(/\$([0-9,]+\.[0-9]{2})/);

            seenIds.add(itemId);
            seenUrls.add(fullUrl);
            results.push({
                itemId,
                title,
                price: priceMatch ? parseWalmartPrice(priceMatch[1]) : null,
                currency: 'USD',
                rating: null,
                thumbnail: null,
                url: fullUrl,
                scrapedAt: new Date().toISOString(),
            });
        }
    }

    return results;
}
