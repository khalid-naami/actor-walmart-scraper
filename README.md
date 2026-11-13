# 🛒 Walmart Scraper (Live Prices, Rollback Deals, Stock & UPC)

Extract live Walmart product listings, discounted Rollback prices, stock status, UPC/GTIN barcode identifiers, merchant sellers, and customer reviews at scale.

> **Apify Store Short Description (296 chars):**  
> `Scrape Walmart product listings, live prices, Rollback discounts, in-store & online stock, UPC barcodes, seller channels, and reviews at scale. Supports direct Item IDs, product URLs, and keyword search with residential proxy rotation for price matching, retail arbitrage, and inventory tracking.`

---

## 🌟 Key Features

- 🏷️ **Rollback & Clearance Detection**: Automatically tags deal types (`Rollback`, `Reduced price`, `Clearance`, `Regular`) and extracts the previous "Was price".
- 📦 **UPC / GTIN Barcodes**: Extracts universal barcode numbers, enabling instant cross-referencing with Amazon ASINs for retail arbitrage.
- 🏪 **Merchant & Fulfillment Channels**: Identifies whether the item is "Sold & Shipped by Walmart.com" or a 3rd party Marketplace Pro Seller.
- ⚡ **Multi-Mode Input**: Input numerical Walmart Item IDs, paste direct product URLs, or search across categories by keywords.
- 🔄 **Smart Search Sorting**: Sort search results by Best Seller, Price (Low to High / High to Low), Customer Rating, or New Arrivals.
- 🖼️ **High-Resolution Galleries**: Captures high-definition primary thumbnails and full gallery image arrays.
- 🛡️ **Anti-Bot & PerimeterX Bypass**: Powered by got-scraping with browser emulation and automatic Playwright fallback.

---

## 📥 Input Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `productUrls` | Array | `["https://www.walmart.com/ip/..."]` | List of direct Walmart product links. |
| `itemIds` | Array | `[]` | List of numerical Walmart Item IDs. |
| `searchKeywords` | Array | `[]` | Keywords to search on Walmart (e.g. `'air fryer'`). |
| `sortBy` | String | `"best_seller"` | Sort order: `best_seller`, `price_low`, `price_high`, `rating_high`, `new`. |
| `maxProducts` | Integer | `40` | Maximum product records to extract per keyword. |
| `proxyConfiguration` | Object | `{ "useApifyProxy": true }` | Apify Proxy settings to bypass anti-scraping blocks. |

---

## 📤 Output Data Format

```json
{
  "itemId": "987654321",
  "title": "Ninja Air Fryer Pro 4-in-1 with 5-QT Capacity (Air Fry, Roast, Reheat, Dehydrate)",
  "price": 89.00,
  "originalPrice": 119.00,
  "currency": "USD",
  "priceType": "Rollback",
  "rating": 4.8,
  "reviewsCount": 4250,
  "inStock": true,
  "stockStatus": "In stock",
  "brand": "Ninja",
  "sellerName": "Walmart.com",
  "upc": "622356562011",
  "badge": "Popular pick",
  "description": "The Ninja Air Fryer Pro delivers crispy, golden results with up to 75% less fat than traditional frying methods...",
  "thumbnail": "https://i5.walmartimages.com/seo/Ninja-Air-Fryer-Pro_abc.jpeg",
  "images": [
    "https://i5.walmartimages.com/seo/Ninja-Air-Fryer-Pro_abc.jpeg",
    "https://i5.walmartimages.com/seo/Ninja-Air-Fryer-Pro_def.jpeg"
  ],
  "url": "https://www.walmart.com/ip/987654321",
  "scrapedAt": "2026-11-10T12:35:00.000Z"
}
```

---

## 💡 Practical Commercial Use Cases

1. **Amazon & Walmart Arbitrage**: Cross-match Walmart Rollback deals against Amazon BuyBox prices using UPC barcodes to find massive profit margins.
2. **Competitive Price Matching**: Track pricing changes across essential retail consumer goods and groceries.
3. **Inventory & Stock Monitoring**: Receive instant alerts when high-demand items or gaming consoles return to stock.
4. **Marketplace Seller Intelligence**: Distinguish official Walmart retail inventory from third-party marketplace merchant offers.

---

## ⚖️ License
Apache-2.0
