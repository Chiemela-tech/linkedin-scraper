const { Actor } = require('apify');
const { playwrightUtils } = require('apify');
const { chromium } = require('playwright');

Actor.main(async () => {
    // 1. Get input
    const input = await Actor.getInput();
    const { companyUrl, li_at, maxWaitMs = 30000 } = input;

    if (!li_at) {
        throw new Error('LinkedIn session cookie "li_at" is required.');
    }

    // 2. Parse company slug
    let slug = companyUrl.trim();
    if (slug.includes('linkedin.com/company/')) {
        slug = slug.split('linkedin.com/company/')[1].split('/')[0];
    }
    const peopleUrl = `https://www.linkedin.com/company/${slug}/people/`;

    console.log(`Starting scraper for company slug: ${slug}`);
    console.log(`Navigating to: ${peopleUrl}`);

    // 3. Launch browser
    const browser = await chromium.launch({
        headless: true,
    });
    
    // Create a context with a realistic User-Agent and the session cookie
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });
    await context.addCookies([
        {
            name: 'li_at',
            value: li_at,
            domain: '.www.linkedin.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'None',
        }
    ]);

    const page = await context.newPage();

    try {
        // 4. Navigate to the People tab
        await page.goto(peopleUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        console.log('Page loaded (DOM content). Current URL:', page.url());

        // Wait for the member count to appear - using a more resilient selector pattern
        // Sometimes LinkedIn uses different classes, so we'll look for text containing 'associated members'
        try {
            await page.waitForFunction(() => {
                const headers = Array.from(document.querySelectorAll('h2, span, div'));
                return headers.some(h => h.textContent.includes('associated members'));
            }, { timeout: 30000 });
            console.log('Member count section found!');
        } catch (e) {
            console.log('Member count not found via function. Taking debug screenshot...');
            await page.screenshot({ path: 'debug_failure.png' });
            throw new Error(`Timeout waiting for member count. Screenshot saved to debug_failure.png. Current URL: ${page.url()}`);
        }

        // 5. Extract member count
        const totalMembers = await page.evaluate(() => {
            // Find the specific header that mentions "associated members"
            const headers = Array.from(document.querySelectorAll('h2, span, strong, div'));
            const memberHeader = headers.find(h => h.textContent.includes('associated members') && h.textContent.length < 100);
            
            if (!memberHeader) return 0;
            
            // Extract the number specifically from the text (e.g., "668,874 associated members")
            const match = memberHeader.textContent.match(/[\d,.]+/);
            return match ? parseInt(match[0].replace(/[,.]/g, ''), 10) : 0;
        });

        console.log(`Extracted total members: ${totalMembers}`);

        // 6. Extract top 5 locations
        const locationSelector = '.org-people-bar-graph-element';
        await page.waitForSelector(locationSelector, { timeout: 10000 });

        const locations = await page.evaluate((selector) => {
            const items = Array.from(document.querySelectorAll(selector));
            
            return items.slice(0, 5).map((el) => {
                // The count is almost always in a <strong> tag or the first piece of text with numbers
                const strongEl = el.querySelector('strong');
                const countText = strongEl ? strongEl.textContent.trim() : (el.textContent.match(/[\d,.]+/) || ['0'])[0];
                
                // The location name is usually in a span or just the remaining text
                // We'll look for the element that DOESN'T have the count
                const categoryEl = el.querySelector('.org-people-bar-graph-element__category, .org-people-bar-graph-element__label, span');
                const categoryText = categoryEl ? categoryEl.textContent.trim() : 'Unknown';
                
                return {
                    location: categoryText,
                    count: parseInt(countText.replace(/[,.]/g, ''), 10) || 0,
                };
            });
        }, locationSelector);

        const result = {
            company: slug,
            totalMembers,
            topLocations: locations,
            url: peopleUrl,
            timestamp: new Date().toISOString(),
        };

        console.log('Scrape successful:', JSON.stringify(result, null, 2));

        // 7. Store results
        await Actor.pushData(result);

    } catch (error) {
        console.error('Scraping failed:', error.message);
        // Take a screenshot on failure for debugging if in Apify environment
        if (process.env.APIFY_IS_AT_HOME) {
            const screenshot = await page.screenshot();
            await Actor.setValue('debug-screenshot', screenshot, { contentType: 'image/png' });
        }
        throw error;
    } finally {
        await browser.close();
    }
});
