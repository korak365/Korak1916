// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor } from 'apify';
// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { CheerioCrawler, Dataset } from 'crawlee';

// The init() call configures the Actor for its environment. It's recommended to start every Actor with an init()
await Actor.init();

// Structure of input is defined in input_schema.json
const { 
    startUrls = [
        'https://www.walmart.com/search?q=electronics',
        'https://www.target.com/s?searchTerm=electronics'
    ], 
    maxRequestsPerCrawl = 100,
    searchTerms = ['electronics', 'clothing', 'home-goods'],
    locations = ['10001', '90210', '60601'],
    priceThreshold = 5
} = (await Actor.getInput()) ?? {};

// Proxy configuration to rotate IP addresses and prevent blocking (https://docs.apify.com/platform/proxy)
const proxyConfiguration = await Actor.createProxyConfiguration();

// Store price data for comparison
const priceData = {};

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    async requestHandler({ request, $, log }) {
        log.info('Processing page:', { url: request.loadedUrl });

        try {
            // Determine which retailer we're scraping
            const isWalmart = request.loadedUrl.includes('walmart.com');
            const isTarget = request.loadedUrl.includes('target.com');

            if (!isWalmart && !isTarget) {
                log.warning('Unknown retailer, skipping:', { url: request.loadedUrl });
                return;
            }

            const retailer = isWalmart ? 'walmart' : 'target';

            // Extract products based on retailer
            if (isWalmart) {
                $('[data-testid="ProductCard"]').each((index, element) => {
                    const $product = $(element);
                    
                    const productName = $product.find('[data-testid="ProductCardTitle"]').text().trim() || 'N/A';
                    const priceText = $product.find('[data-testid="ProductPrice"]').text().trim() || 'N/A';
                    const price = parsePrice(priceText);
                    const productUrl = $product.find('a[href*="/ip/"]').attr('href') || 'N/A';
                    const fullUrl = productUrl !== 'N/A' ? `https://www.walmart.com${productUrl}` : 'N/A';

                    if (!productName || productName === 'N/A') return;

                    // Create a product key for matching
                    const productKey = productName.toLowerCase().substring(0, 30);

                    if (!priceData[productKey]) {
                        priceData[productKey] = {
                            productName,
                            category: extractCategory(request.loadedUrl),
                            walmart: { price, url: fullUrl },
                            target: null,
                            locations: {}
                        };
                    } else {
                        priceData[productKey].walmart = { price, url: fullUrl };
                    }

                    log.info(`Found Walmart product: ${productName}`, { price });
                });
            } else if (isTarget) {
                $('[data-testid="product-card"]').each((index, element) => {
                    const $product = $(element);
                    
                    const productName = $product.find('[data-testid="product-title"]').text().trim() || 'N/A';
                    const priceText = $product.find('[data-testid="product-price"]').text().trim() || 'N/A';
                    const price = parsePrice(priceText);
                    const productUrl = $product.find('a').attr('href') || 'N/A';
                    const fullUrl = productUrl !== 'N/A' ? `https://www.target.com${productUrl}` : 'N/A';

                    if (!productName || productName === 'N/A') return;

                    // Create a product key for matching
                    const productKey = productName.toLowerCase().substring(0, 30);

                    if (!priceData[productKey]) {
                        priceData[productKey] = {
                            productName,
                            category: extractCategory(request.loadedUrl),
                            walmart: null,
                            target: { price, url: fullUrl },
                            locations: {}
                        };
                    } else {
                        priceData[productKey].target = { price, url: fullUrl };
                    }

                    log.info(`Found Target product: ${productName}`, { price });
                });
            }
        } catch (error) {
            log.error('Error processing page:', { 
                url: request.loadedUrl,
                error: error.message 
            });
        }
    },
    
    errorHandler: async ({ request, error, log }) => {
        log.warning('Request failed:', { 
            url: request.loadedUrl,
            error: error.message 
        });
    },
});

await crawler.run(startUrls);

// Process and output comparison data
log.info('Processing price comparisons...');

for (const [key, data] of Object.entries(priceData)) {
    if (data.walmart && data.target) {
        const walmartPrice = data.walmart.price;
        const targetPrice = data.target.price;

        if (walmartPrice > 0 && targetPrice > 0) {
            const priceDifference = ((targetPrice - walmartPrice) / walmartPrice) * 100;

            if (Math.abs(priceDifference) >= priceThreshold) {
                const winner = priceDifference < 0 ? 'Walmart' : 'Target';
                const savingsAmount = Math.abs(targetPrice - walmartPrice).toFixed(2);

                await Dataset.pushData({
                    productName: data.productName,
                    category: data.category,
                    location: locations[0] || 'N/A',
                    walmartPrice: `$${walmartPrice.toFixed(2)}`,
                    targetPrice: `$${targetPrice.toFixed(2)}`,
                    priceDifference: parseFloat(priceDifference.toFixed(2)),
                    winner,
                    walmartUrl: data.walmart.url,
                    targetUrl: data.target.url,
                    savingsAmount: `$${savingsAmount}`
                });

                log.info(`Price comparison: ${data.productName}`, {
                    walmart: `$${walmartPrice.toFixed(2)}`,
                    target: `$${targetPrice.toFixed(2)}`,
                    difference: `${priceDifference.toFixed(2)}%`,
                    winner
                });
            }
        }
    }
}

// Helper function to parse price from text
function parsePrice(priceText) {
    const match = priceText.match(/\$?([\d,]+\.?\d*)/);
    if (match) {
        return parseFloat(match[1].replace(/,/g, ''));
    }
    return 0;
}

// Helper function to extract category from URL
function extractCategory(url) {
    if (url.includes('electronics')) return 'electronics';
    if (url.includes('clothing') || url.includes('apparel')) return 'clothing';
    if (url.includes('home')) return 'home-goods';
    if (url.includes('grocery') || url.includes('food')) return 'grocery';
    return 'general';
}

// Gracefully exit the Actor process. It's recommended to quit all Actors with an exit()
await Actor.exit();