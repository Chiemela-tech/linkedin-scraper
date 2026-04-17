import asyncio
import re
import time
from apify import Actor
from playwright.async_api import async_playwright

# Constants
URL = "https://www.linkedin.com/company/accenture/jobs/"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
}

async def main():
    async with Actor:
        # Get input
        actor_input = await Actor.get_input() or {}
        li_at = actor_input.get("li_at")
        
        # Determine the URL to scrape (Input first, then fallback)
        url = actor_input.get("url") or actor_input.get("companyUrl") or actor_input.get("companyJobsUrl") or URL

        if not li_at:
            Actor.log.error("Missing 'li_at' session cookie in input!")
            await Actor.fail(status_message="LinkedIn li_at cookie is required for this scraper.")
            return

        async with async_playwright() as pw:
            Actor.log.info(f"Launching VISIBLE browser for debugging: {url}")
            # Setting headless=False so you can see the window pop up
            browser = await pw.chromium.launch(headless=False)
            
            ctx = await browser.new_context(
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                viewport={'width': 1440, 'height': 900}
            )
            
            page = await ctx.new_page()
            try:
                # Step 1: Visit homepage WITHOUT cookies first
                Actor.log.info("Visiting LinkedIn homepage to establish session...")
                await page.goto("https://www.linkedin.com/", wait_until="domcontentloaded", timeout=30000)
                await asyncio.sleep(2)

                # Step 2: Inject the cookie now
                Actor.log.info("Injecting li_at cookie...")
                await ctx.add_cookies([{
                    "name": "li_at",
                    "value": li_at.strip().replace('"', ''),
                    "domain": ".linkedin.com",
                    "path": "/",
                }])

                # Step 3: Refresh to apply cookie
                await page.reload(wait_until="domcontentloaded")
                await asyncio.sleep(3)

                # Step 4: Navigate to the actual jobs page
                Actor.log.info(f"Navigating to Target URL: {url}")
                await page.goto(url, wait_until="domcontentloaded", timeout=60000)
                await asyncio.sleep(5)
                
                # Dynamic wait for the headline to appear
                selector = "h4.org-jobs-job-search-form-module__headline"
                Actor.log.info(f"Waiting for selector: {selector}")
                
                # Small wait to ensure JS has started rendering
                await asyncio.sleep(3)
                
                el = await page.wait_for_selector(selector, timeout=15000)
                if el:
                    raw_text = (await el.inner_text()).strip()
                    Actor.log.info(f"Found raw text: '{raw_text}'")
                    
                    # Extract the number from "Accenture has 38,441 job openings"
                    match = re.search(r"([\d,]+)", raw_text)
                    if match:
                        count_str = match.group(1)
                        formatted_output = f"Company has {count_str} job openings now"
                        
                        Actor.log.info(f"SUCCESS: {formatted_output}")
                        
                        # Save result to dataset
                        await Actor.push_data({
                            "company": "Company",
                            "jobCountText": formatted_output,
                            "count": int(count_str.replace(",", "")),
                            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                        })
                    else:
                        Actor.log.error("Could not parse number from headline.")
                else:
                    Actor.log.error("Job count headline not found. Check if the session cookie is valid.")
                    
            except Exception as e:
                Actor.log.error(f"Scrape failed: {str(e)}")
                # Check for redirect to login
                if "/login" in page.url:
                    Actor.log.error("Redirected to login page. Your li_at cookie may be invalid or expired.")
            finally:
                await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
