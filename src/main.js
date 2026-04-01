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
        headless: true, // Use headless for performance, but can be disabled for debugging
    });
    
    // Create a context with the session cookie
    const context = await browser.newContext();
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
        await page.goto(peopleUrl, { waitUntil: 'networkidle', timeout: maxWaitMs });

        // Wait for the member count to appear
        const countSelector = 'h2.t-20.t-black.t-bold';
        await page.waitForSelector(countSelector, { timeout: 15000 });

        // 5. Extract member count
        const totalMembersRaw = await page.textContent(countSelector);
        const totalMembers = parseInt(totalMembersRaw.replace(/[^0-9]/g, ''), 10);

        console.log(`Extracted total members: ${totalMembers}`);

        // 6. Extract top 5 locations
        // We wait for the location elements
        const locationSelector = '.org-people-bar-graph-element';
        await page.waitForSelector(locationSelector, { timeout: 10000 });

        const locations = await page.$$eval(locationSelector, (elements) => {
            return elements.slice(0, 5).map((el) => {
                const countStr = el.querySelector('.org-people-bar-graph-element__amount')?.textContent || '0';
                const location = el.querySelector('.org-people-bar-graph-element__category')?.textContent || 'Unknown';
                return {
                    location: location.trim(),
                    count: parseInt(countStr.replace(/[^0-9]/g, ''), 10),
                };
            });
        });

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
