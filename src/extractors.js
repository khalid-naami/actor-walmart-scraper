/**
 * Walmart Product & Search Extraction Handlers
 */

/**
 * Extract numerical Walmart Item ID from URL
 */
export function extractWalmartItemId(url) {
    if (!url || typeof url !== 'string') return null;
    const match = url.match(/\/ip\/(?:[^\/]+\/)?(\d{8,12})/i) || url.match(/itemId=(\d{8,12})/i);
    return match ? match[1] : null;
}

/**
 * Clean numeric price from string
 */
export function parseWalmartPrice(raw) {
    if (typeof raw === 'number') return raw;
    if (!raw || typeof raw !== 'string') return null;
    const cleaned = raw.replace(/[^0-9.,]/g, '').trim();
    if (!cleaned) return null;
    if (cleaned.includes(',') && !cleaned.includes('.')) {
        return parseFloat(cleaned.replace(',', '.'));
    }
    return parseFloat(cleaned.replace(/,/g, ''));
}

/**
 * Clean star rating
 */
export function parseWalmartRating(raw) {
    if (typeof raw === 'number') return raw;
    if (!raw || typeof raw !== 'string') return null;
    const match = raw.replace(',', '.').match(/([0-5]\.[0-9]|[0-5])/);
    return match ? parseFloat(match[1]) : null;
}

/**
 * Clean review count
 */
export function parseWalmartReviewsCount(raw) {
    if (typeof raw === 'number') return raw;
    if (!raw || typeof raw !== 'string') return 0;
    const digits = raw.replace(/[^\d]/g, '');
    return digits ? parseInt(digits, 10) : 0;
}

/**
 * Parse product details from Walmart HTML (supports __NEXT_DATA__, JSON-LD & DOM)
 */
export function parseWalmartProductHtml(html, url = '') {
    if (!html) return null;

    const itemId = extractWalmartItemId(url);

    // 1. Check __NEXT_DATA__ state
    try {
        const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
        if (nextDataMatch) {
            const parsed = JSON.parse(nextDataMatch[1]);
            const p = parsed?.props?.pageProps?.initialData?.data?.product;
            if (p) {
                const currentPrice = p.priceInfo?.currentPrice?.price ?? null;
                const wasPrice = p.priceInfo?.wasPrice?.price ?? null;
                const priceType = p.priceInfo?.priceType || (wasPrice ? 'Rollback' : 'Regular');

                const images = (p.imageInfo?.allImages || []).map((img) => img.url).filter(Boolean);
                const thumbnail = p.imageInfo?.thumbnailUrl || images[0] || null;

                return {
                    itemId: p.usItemId || itemId,
                    title: p.name,
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
                    description: p.shortDescription?.replace(/<[^>]+>/g, '').trim() || null,
                    thumbnail,
                    images: [...new Set(images)],
                    url: p.canonicalUrl ? `https://www.walmart.com${p.canonicalUrl}` : url,
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
        const ldMatches = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
        if (ldMatches) {
            for (const script of ldMatches) {
                const jsonText = script.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
                const d = JSON.parse(jsonText);
                if (d['@type'] === 'Product') {
                    ldData = d;
                    break;
                }
            }
        }
    } catch {
        // Fallback
    }

    // Title
    let title = ldData?.name || null;
    if (!title) {
        const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
                           html.match(/itemprop="name"[^>]*>([\s\S]*?)<\/(?:h1|span)>/i);
        if (titleMatch) title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
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
        inStock = !ldData.offers.availability.toLowerCase().includes('outofstock');
    }

    // Brand & Seller
    let brand = ldData?.brand?.name || (typeof ldData?.brand === 'string' ? ldData.brand : null);
    let sellerName = 'Walmart.com';
    const sellerMatch = html.match(/data-testid="seller-name"[^>]*>([^<]+)<\/span>/i);
    if (sellerMatch) sellerName = sellerMatch[1].trim();

    // UPC / Barcode
    const upc = ldData?.gtin12 || ldData?.gtin13 || ldData?.upc || null;

    // Images
    const images = [];
    if (Array.isArray(ldData?.image)) images.push(...ldData.image);
    else if (typeof ldData?.image === 'string') images.push(ldData.image);

    const imgMatches = [...html.matchAll(/data-testid="hero-image-container"[^>]*src="([^"]+)"/gi)];
    for (const m of imgMatches) images.push(m[1]);

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
        description: ldData?.description || null,
        thumbnail,
        images: [...new Set(images)],
        url,
        scrapedAt: new Date().toISOString(),
    };
}

/**
 * Extract items from Walmart Search SERP HTML
 */
export function parseWalmartSearchHtml(html) {
    const results = [];
    if (!html) return results;

    const cards = [...html.matchAll(/data-item-id="([^"]+)"[\s\S]*?(?=<div[^>]*data-item-id=|$)/gi)];

    for (const c of cards) {
        const itemId = c[1];
        const cardHtml = c[0];

        // Title
        const titleMatch = cardHtml.match(/data-automation-id="product-title"[^>]*>([\s\S]*?)<\/span>/i) ||
                           cardHtml.match(/class="[^"]*product-title-link[^"]*"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
        if (!titleMatch) continue;

        const title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
        if (!title) continue;

        // URL
        const linkMatch = cardHtml.match(/href="(\/ip\/[^"]+)"/i);
        const fullUrl = linkMatch ? `https://www.walmart.com${linkMatch[1].split('?')[0]}` : null;

        // Price
        const priceMatch = cardHtml.match(/class="[^"]*(?:price-main|w_iU)[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ||
                           cardHtml.match(/\$([0-9,]+\.[0-9]{2})/);
        const price = priceMatch ? parseWalmartPrice(priceMatch[1]) : null;

        // Rating
        const ratingMatch = cardHtml.match(/data-testid="product-ratings"[^>]*aria-label="([0-9.,]+)\s*out of/i);
        const rating = ratingMatch ? parseWalmartRating(ratingMatch[1]) : null;

        // Thumbnail
        const imgMatch = cardHtml.match(/data-testid="productTileImage"[^>]*src="([^"]+)"/i) ||
                         cardHtml.match(/<img[^>]*src="([^"]+)"/i);
        const thumbnail = imgMatch ? imgMatch[1] : null;

        results.push({
            itemId,
            title,
            price,
            currency: 'USD',
            rating,
            thumbnail,
            url: fullUrl || `https://www.walmart.com/ip/${itemId}`,
            scrapedAt: new Date().toISOString(),
        });
    }

    return results;
}
