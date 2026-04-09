import asyncio
import re
import time
import random
from bs4 import BeautifulSoup
from apify import Actor
from playwright.sync_api import sync_playwright

# Constants
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": "https://www.linkedin.com/",
    "Connection": "keep-alive",
}

def extract_number(text: str, keep_plus: bool = False) -> str:
    """Extract first integer from string, handles commas and 1.2K style."""
    if not text:
        return "0"
    text = text.strip()
    k_match = re.search(r"([\d,]+\.?\d*)\s*[Kk]", text)
    if k_match:
        val = int(float(k_match.group(1).replace(",", "")) * 1000)
        return str(val)
    cleaned = text.replace(",", "")
    pattern = r"\d+\+?" if keep_plus else r"\d+"
    match = re.search(pattern, cleaned)
    if match:
        result = match.group()
        if not keep_plus:
            result = result.replace("+", "")
        return result
    return "0"

def scrape_linkedin(url: str, li_at: str = None) -> dict:
    """Main scraping logic for Remote Jobs using Playwright."""
    with sync_playwright() as pw:
        Actor.log.info(f"Launching browser to scrape remote jobs: {url}")
        browser = pw.chromium.launch(headless=True)
        ctx = browser.new_context(
            user_agent=HEADERS["User-Agent"],
            viewport={'width': 1280, 'height': 800}
        )
        if li_at:
            ctx.add_cookies([{
                "name": "li_at",
                "value": li_at,
                "domain": ".linkedin.com",
                "path": "/",
            }])
        
        page = ctx.new_page()
        try:
            page.goto(url, wait_until="load", timeout=60000)
            time.sleep(5) # Wait for dynamic content
            
            if "login" in page.url or "checkpoint" in page.url:
                Actor.log.warning(f"Note: Page redirected to login view, but we will still attempt extraction.")
        except Exception as e:
            browser.close()
            return {"error": str(e), "success": False}

        # Selectors focused on Remote Job results
        selectors = [
            ".jobs-search-results-list__text span",
            "small.jobs-search-results-list__text",
            "span.results-context-header__job-count",
            "h1.jobs-search-results-list__title",
        ]

        result = {"company": "Unknown", "totalRemoteJobs": "0", "raw_text": "Not found"}
        
        # Try selectors
        for sel in selectors:
            try:
                el = page.wait_for_selector(sel, timeout=5000)
                if el:
                    raw = el.inner_text()
                    if re.search(r"\d", raw):
                        result["totalRemoteJobs"] = extract_number(raw, keep_plus=True)
                        result["raw_text"] = raw
                        break
            except:
                continue

        # Body regex fallback for remote patterns
        if result["totalRemoteJobs"] == "0":
            body_text = page.inner_text("body")
            patterns = [
                r"([\d,]+\+?)\s+(?:remote\s+)?(?:results?|jobs?)",
            ]
            for p in patterns:
                m = re.search(p, body_text, re.I)
                if m:
                    result["totalRemoteJobs"] = extract_number(m.group(1), keep_plus=True)
                    result["raw_text"] = m.group(0)
                    break

        # Get company name from title
        try:
            result["company"] = page.title().split("|")[0].split("–")[0].strip()
        except:
            pass
            
        browser.close()
        return {**result, "success": True, "url": url}

async def main():
    async with Actor:
        # Get input
        actor_input = await Actor.get_input() or {}
        url = actor_input.get("url") or actor_input.get("companyUrl")
        li_at = actor_input.get("li_at")

        if not url:
            Actor.log.error("Missing 'url' in input!")
            return

        # Execute scrape
        result = scrape_linkedin(url, li_at)
        
        # Save results
        if result.get("success"):
            Actor.log.info(f"Successfully scraped {result['company']}: {result['totalRemoteJobs']} remote jobs")
            await Actor.push_data(result)
        else:
            Actor.log.error(f"Scrape failed: {result.get('error')}")
            await Actor.fail(status_message=result.get("error"))

if __name__ == "__main__":
    asyncio.run(main())
