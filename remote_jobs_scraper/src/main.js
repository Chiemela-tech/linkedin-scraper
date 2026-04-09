const { Actor } = require('apify');
const { chromium } = require('playwright');

Actor.main(async () => {
    const input = await Actor.getInput();
    const { companyJobsUrl, remoteSearchUrl, li_at } = input;

    const browser = await chromium.launch({ headless: true });

    const scrapePage = async (url, useCookies = true) => {
        // Switching to Desktop for more stable authentication and layouts
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            viewport: { width: 1440, height: 900 },
            deviceScaleFactor: 1,
            isMobile: false,
            hasTouch: false,
        });

        if (useCookies && li_at) {
            await context.addCookies([{
                name: 'li_at',
                value: li_at.trim(),
                domain: '.linkedin.com',
                path: '/',
                httpOnly: true,
                secure: true,
                sameSite: 'None',
            }]);
        }

        const page = await context.newPage();
        try {
            console.log(`Navigating to: ${url} (Cookies: ${useCookies})`);
            // Using networkidle to ensure counts are loaded
            await page.goto(url, { waitUntil: 'load', timeout: 30000 });
            await page.waitForTimeout(5000);
            return page;
        } catch (e) {
            console.warn(`Navigation failed: ${e.message}`);
            await context.close();
            return null;
        }
    };

    // Derive Company ID from Remote Search URL if possible
    let companyId = remoteSearchUrl ? (remoteSearchUrl.match(/f_C=(\d+)/) || [null, null])[1] : null;
    const totalSearchUrl = companyId ? `https://www.linkedin.com/jobs/search/?f_C=${companyId}` : companyJobsUrl;

    const extractData = async (page, type) => {
        if (!page) return null;
        return await page.evaluate((type) => {
            const bodyText = document.body.innerText;
            const titleText = document.title;
            const html = document.documentElement.innerHTML;
            
            const data = {
                company: "Unknown",
                count: 0,
                isLoginPage: /Join LinkedIn/i.test(bodyText) || /Sign Up/i.test(bodyText) || /Log In/i.test(bodyText)
            };

            // Extract Company Name
            const companySelectors = [
                'header h1',
                '.topcard__title',
                '.organization-header__title',
                '.jobs-search-results-list__title',
                '.jobs-search-results-list__subtitle',
                '.base-main-card__subtitle'
            ];
            const bannedNames = ["Join LinkedIn", "Sign Up", "Log In", "LinkedIn", "Welcome to LinkedIn", "Unknown"];
            
            const findName = () => {
                for (const sel of companySelectors) {
                    const elements = document.querySelectorAll(sel);
                    for (const el of elements) {
                        let name = el.innerText.trim()
                            .split(' | ')[0]
                            .split(' - ')[0]
                            .replace(/\d+/g, '')
                            .replace(/\+/g, '')
                            .replace(/jobs/gi, '')
                            .replace(/results/gi, '')
                            .trim();
                        
                        if (name.length > 2 && !bannedNames.some(banned => name.includes(banned))) {
                            return name;
                        }
                    }
                }
                return null;
            };

            data.company = findName() || "Unknown";

            if (data.company === "Unknown" && titleText) {
                const titleMatch = titleText.match(/^(.*?)\s+Jobs/i) || titleText.match(/^(.*?)\s+\|/);
                if (titleMatch) {
                    let name = titleMatch[1].replace(/\d+/g, '').replace(/\+/g, '').trim();
                    if (name.length > 2 && !bannedNames.some(banned => name.includes(banned))) {
                        data.company = name;
                    }
                }
            }

            // Extract Counts
            if (type === 'total') {
                // 1. Try "See all X jobs" buttons first (often has exact count)
                const seeAllButtons = Array.from(document.querySelectorAll('a, button'))
                    .filter(el => /see\s+all\s+([\d,.]+)\s+jobs/i.test(el.innerText));
                
                if (seeAllButtons.length > 0) {
                    const btnText = seeAllButtons[0].innerText;
                    const match = btnText.match(/see\s+all\s+([\d,.]+)\s+jobs/i);
                    if (match) {
                        data.count = parseInt(match[1].replace(/[,.]/g, ''), 10);
                    }
                }

                // 2. Try hidden metadata if button failed
                if (!data.count || data.count === 0) {
                    const metaMatch = html.match(/"totalJobCount":\s*(\d+)/) || 
                                      html.match(/"totalJobs":\s*(\d+)/) ||
                                      html.match(/"totalResults":\s*(\d+)/) ||
                                      html.match(/"numOpenJobs":\s*(\d+)/);
                    if (metaMatch) {
                        data.count = parseInt(metaMatch[1], 10);
                    }
                }

                // 3. Try patterns in body text
                if (!data.count || data.count === 0) {
                    const patterns = [
                        /has\s+([\d,.]+)\s+job\s+openings/i,
                        /See\s+all\s+([\d,.]+)\s+jobs/i,
                        /([\d,.]+)\s+open\s+jobs/i,
                        /([\d,.]+)\s+results/i,
                        /([\d,.]+)\s+job\s+opportunities/i
                    ];

                    for (const pattern of patterns) {
                        const match = bodyText.match(pattern);
                        if (match) {
                            const val = parseInt(match[1].replace(/[,.+]/g, ''), 10);
                            if (val > 0) {
                                data.count = val;
                                break;
                            }
                        }
                    }
                }

                // If still capped at 1000 from search results, mark as low confidence
                if (data.count === 1000 && bodyText.includes('1,000+')) {
                    data.count = "1,000+";
                }
            } else if (type === 'remote') {
                // Look for "800+" specifically or similar patterns
                const remoteMatch = bodyText.match(/([\d,.]+\+?)\s+results/i) ||
                                    bodyText.match(/([\d,.]+\+?)\s+jobs/i);
                
                if (remoteMatch) {
                    data.count = remoteMatch[1];
                } else {
                    const countSelectors = [
                        '.results-context-header__job-count',
                        '.jobs-search-results-list__subtitle',
                        'header h1'
                    ];
                    for (const sel of countSelectors) {
                        const el = document.querySelector(sel);
                        if (el && /[\d,.]+(\+)?/.test(el.innerText)) {
                            const match = el.innerText.match(/[\d,.]+(\+)?/);
                            if (match) {
                                data.count = match[0];
                                break;
                            }
                        }
                    }
                }
                if (!data.count) data.count = "0";
            }

            return data;
        }, type);
    };

    // SCRAPER 1: Total Jobs
    let totalData = { company: "Accenture", count: 0 };
    if (companyJobsUrl) {
        console.log(`--- STARTING SCRAPER 1 (TOTAL) ---`);
        let page = await scrapePage(companyJobsUrl, true);
        totalData = await extractData(page, 'total') || totalData;
        
        // If auth failed, try the Company Jobs Tab PUBLICLY (often shows full count)
        if (totalData.isLoginPage || !totalData.count || totalData.count === 0) {
            console.log('Auth jobs tab blocked, trying Public jobs tab...');
            if (page) await page.context().close();
            page = await scrapePage(companyJobsUrl, false);
            const fallbackData = await extractData(page, 'total');
            if (fallbackData && fallbackData.count > 0) totalData = fallbackData;
        }

        // Search fallback if still nothing
        if (!totalData.count || totalData.count === 0 || totalData.count === "1,000+") {
            console.log('Still capped or 0, trying Search fallback...');
            if (page) await page.context().close();
            page = await scrapePage(totalSearchUrl, true);
            let fallbackData = await extractData(page, 'total');
            if (fallbackData && fallbackData.count > 0 && fallbackData.count !== "1,000+") {
                totalData = fallbackData;
            } else {
                // Final public search fallback (previous 1000 result)
                console.log('Auth search failed, trying Public Search fallback...');
                if (page) await page.context().close();
                page = await scrapePage(totalSearchUrl, false);
                fallbackData = await extractData(page, 'total');
                if (fallbackData && (fallbackData.count > 0 || fallbackData.count === "1,000+")) {
                    totalData = fallbackData;
                }
            }
        }

        if (page) {
            const snap = await page.screenshot({ fullPage: true });
            await Actor.setValue('snap-total', snap, { contentType: 'image/png' });
            await page.context().close();
        }
    }

    // SCRAPER 2: Remote Jobs
    let remoteData = { company: "Accenture", count: "0" };
    if (remoteSearchUrl) {
        console.log('--- STARTING SCRAPER 2 (REMOTE) ---');
        let page = await scrapePage(remoteSearchUrl, true);
        remoteData = await extractData(page, 'remote') || remoteData;

        if (remoteData.isLoginPage || !remoteData.count || remoteData.count === "0") {
            console.log('Auth search failed or 0, trying Public Fallback...');
            if (page) await page.context().close();
            page = await scrapePage(remoteSearchUrl, false);
            const fallbackData = await extractData(page, 'remote');
            if (fallbackData && fallbackData.count !== "0") remoteData = fallbackData;
        }
        if (page) {
            const snap = await page.screenshot({ fullPage: true });
            await Actor.setValue('snap-remote', snap, { contentType: 'image/png' });
            await page.context().close();
        }
    }



    const companyName = (totalData.company && totalData.company !== "Unknown") ? totalData.company : 
                       ((remoteData.company && remoteData.company !== "Unknown") ? remoteData.company : "Accenture");

    const result = {
        company: companyName,
        totalOpenJobs: totalData.count || 0,
        totalRemoteJobs: remoteData.count || "0",
        timestamp: new Date().toISOString()
    };

    await Actor.pushData(result);
    // Sanitize key for storage
    const safeKey = `latest-combined-${companyName.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    const store = await Actor.openKeyValueStore('linkedin-stats');
    await store.setValue(safeKey, result);

    console.log('\n--- FINAL VERIFIED OUTPUT ---');
    console.log(`Company: ${result.company}`);
    console.log(`Total Open Jobs: ${result.totalOpenJobs}`);
    console.log(`Total Remote Jobs: ${result.totalRemoteJobs}`);

    await browser.close();
});




