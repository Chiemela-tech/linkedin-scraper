import asyncio
import re
import time
from apify import Actor
from playwright.sync_api import sync_playwright

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

        if not li_at:
            Actor.log.error("Missing 'li_at' session cookie in input!")
            await Actor.fail(status_message="LinkedIn li_at cookie is required for this scraper.")
            return

        with sync_playwright() as pw:
            Actor.log.info(f"Launching browser to scrape total jobs: {URL}")
            browser = pw.chromium.launch(headless=True)
            ctx = browser.new_context(user_agent=HEADERS["User-Agent"])
            
            # Set session cookie
            ctx.add_cookies([{
                "name": "li_at",
                "value": li_at,
                "domain": ".linkedin.com",
                "path": "/",
            }])
            
            page = ctx.new_page()
            try:
                # Navigate to the jobs page
                page.goto(URL, wait_until="load", timeout=60000)
                
                # Dynamic wait for the headline to appear
                selector = "h4.org-jobs-job-search-form-module__headline"
                Actor.log.info(f"Waiting for selector: {selector}")
                
                # Small wait to ensure JS has started rendering
                time.sleep(3)
                
                el = page.wait_for_selector(selector, timeout=15000)
                if el:
                    raw_text = el.inner_text().strip()
                    Actor.log.info(f"Found raw text: '{raw_text}'")
                    
                    # Extract the number from "Accenture has 38,441 job openings"
                    match = re.search(r"([\d,]+)", raw_text)
                    if match:
                        count_str = match.group(1)
                        formatted_output = f"Accenture has {count_str} job openings now"
                        
                        Actor.log.info(f"SUCCESS: {formatted_output}")
                        
                        # Save result to dataset
                        await Actor.push_data({
                            "company": "Accenture",
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
                browser.close()

if __name__ == "__main__":
    asyncio.run(main())
