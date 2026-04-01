const { Actor } = require('apify');
const { chromium } = require('playwright');

Actor.main(async () => {
    // 1. Get input
    const input = await Actor.getInput();
    const { companyUrl, li_at, maxWaitMs = 30000 } = input;

    if (!li_at) {
        throw new Error('LinkedIn session cookie "li_at" is required.');
    }

    if (!companyUrl) {
        throw new Error('Company URL or slug is required.');
    }

    // 2. Parse company slug
    let slug = companyUrl.trim();
    if (slug.includes('linkedin.com/company/')) {
        slug = slug.split('linkedin.com/company/')[1].split('/')[0];
    }
    const peopleUrl = slug.startsWith('http') ? slug : `https://www.linkedin.com/company/${slug}/people/`;

    console.log(`Starting scraper for company: ${slug}`);
    console.log(`Navigating to: ${peopleUrl}`);

    // 3. Launch browser
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });

    await context.addCookies([
        {
            name: 'li_at',
            value: li_at,
            domain: '.linkedin.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'None',
        }
    ]);

    const page = await context.newPage();

    try {
        // Use 'domcontentloaded' because LinkedIn's background network often never settles
        await page.goto(peopleUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        // Wait for member count or empty state or login wall
        await page.waitForFunction(() => {
            if (!document.body) return false;
            const text = document.body.innerText;
            return text.includes('associated members') || 
                   text.includes('0 members') || 
                   text.includes('Sign In') || 
                   !!document.querySelector('form.login__form');
        }, { timeout: 30000 });

        // Detect login wall after wait
        const isLoginWall = await page.evaluate(() => {
            return document.title.includes('Sign In') || 
                   !!document.querySelector('form.login__form') ||
                   !!document.querySelector('button[type="submit"][aria-label="Sign in"]');
        });

        if (isLoginWall) {
            throw new Error('Hit the LinkedIn login wall. Your "li_at" cookie is likely invalid or expired.');
        }

        // 5. Extract member count
        // Wait for the member count section to appear
        await page.waitForFunction(() => {
            if (!document.body) return false;
            const text = document.body.innerText;
            return text.includes('associated members') || text.includes('0 members');
        }, { timeout: 30000 });

        const totalMembers = await page.evaluate(() => {
            const headers = Array.from(document.querySelectorAll('h2, span, strong, div'));
            const memberHeader = headers.find(h => {
                const text = h.textContent.toLowerCase();
                return text.includes('associated members') && text.length < 100;
            });
            
            if (!memberHeader) {
                if (document.body.innerText.includes('0 members')) return 0;
                return 0;
            }
            
            const match = memberHeader.textContent.match(/[\d,.]+/);
            return match ? parseInt(match[0].replace(/[,.]/g, ''), 10) : 0;
        });

        console.log(`Extracted total members: ${totalMembers}`);

        // 6. Extract top 5 locations
        const locationSelector = '.org-people-bar-graph-element';
        let locations = [];
        
        try {
            await page.waitForSelector(locationSelector, { timeout: 5000 });
            locations = await page.evaluate((selector) => {
                const items = Array.from(document.querySelectorAll(selector));
                return items.slice(0, 5).map((el) => {
                    const strongEl = el.querySelector('strong');
                    const countText = strongEl ? strongEl.textContent.trim() : (el.textContent.match(/[\d,.]+/) || ['0'])[0];
                    const categoryEl = el.querySelector('.org-people-bar-graph-element__category, .org-people-bar-graph-element__label, span');
                    const categoryText = categoryEl ? categoryEl.textContent.trim() : 'Unknown';
                    
                    return {
                        location: categoryText,
                        count: parseInt(countText.replace(/[,.]/g, ''), 10) || 0,
                    };
                });
            }, locationSelector);
        } catch (e) {
            console.log('No location data found or timed out.');
        }

        const result = {
            company: slug,
            totalMembers,
            topLocations: locations,
            url: peopleUrl,
            timestamp: new Date().toISOString(),
        };

        // 7. Store results in Dataset (standard run history)
        await Actor.pushData(result);

        // 8. ALSO store in a Named Key-Value Store (for "hosting" the latest version)
        const store = await Actor.openKeyValueStore('linkedin-stats');
        await store.setValue(`latest-${slug}`, result);
        
        console.log(`Scrape successful! Latest data hosted in Key-Value store as 'latest-${slug}'`);
        console.log('Result details:', JSON.stringify(result, null, 2));

    } catch (error) {
        console.error('Scraping failed:', error.message);
        
        // Take a screenshot on failure for debugging
        try {
            const screenshot = await page.screenshot({ fullPage: true });
            await Actor.setValue(`debug-failure-${slug}`, screenshot, { contentType: 'image/png' });
        } catch (e) {
            console.error('Failed to take debug screenshot:', e.message);
        }
        
        throw error;
    } finally {
        await browser.close();
    }
});
