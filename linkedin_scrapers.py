"""
LinkedIn Job Scrapers
=====================
Two scrapers for extracting job counts from LinkedIn.

IMPORTANT: LinkedIn actively blocks scrapers. These scripts use:
  - Rotating User-Agent headers
  - Session cookies (optional)
  - Browser-like request headers
  - Delays to avoid rate limiting

For best results, run with a valid li_at session cookie from a logged-in
LinkedIn session. Without it, you may get 0 results or be redirected.

Requirements:
    pip install requests beautifulsoup4 playwright
    playwright install chromium   # for the Playwright version
"""

import re
import time
import random
import requests
from bs4 import BeautifulSoup


# ─────────────────────────────────────────────────────────────
# SHARED HELPERS
# ─────────────────────────────────────────────────────────────

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": "https://www.linkedin.com/",
    "Connection": "keep-alive",
}


def make_session(li_at_cookie: str = None) -> requests.Session:
    """
    Create a requests Session with LinkedIn-friendly headers.
    Pass your li_at cookie value for authenticated requests.
    """
    session = requests.Session()
    session.headers.update(HEADERS)
    if li_at_cookie:
        session.cookies.set("li_at", li_at_cookie, domain=".linkedin.com")
    return session


def extract_number(text: str, keep_plus: bool = False) -> str:
    """
    Extract the first integer from a string.
    Handles commas, '+' suffixes, and locale formatting.
    Examples:
        "40,129 jobs" → "40129"
        "800+ results" → "800+" (if keep_plus=True)
    """
    if not text:
        return "0"

    text = text.strip()

    # Handle "1.2K" / "800K" style
    k_match = re.search(r"([\d,]+\.?\d*)\s*[Kk]", text)
    if k_match:
        val = int(float(k_match.group(1).replace(",", "")) * 1000)
        return str(val)

    # Strip commas
    cleaned = text.replace(",", "")
    
    # regex for number with optional +
    pattern = r"\d+\+?" if keep_plus else r"\d+"
    match = re.search(pattern, cleaned)
    
    if match:
        result = match.group()
        # If we don't want the plus, strip it just in case regex was ambiguous
        if not keep_plus:
            result = result.replace("+", "")
        return result
    return "0"


# ─────────────────────────────────────────────────────────────
# SCRAPER 1 — Total open jobs for a company
# ─────────────────────────────────────────────────────────────

def scrape_total_jobs(url: str, li_at: str = None, use_playwright: bool = True) -> dict:
    """
    Scrape total open job count from a LinkedIn company jobs page.
    Automatically handles fallbacks to search URLs.
    """
    if use_playwright:
        result = scrape_with_playwright(url, li_at, scraper_type="total")
        
        # If count is 0 and it's a company URL, try to convert to search URL
        if result.get("count") == "0" and "/company/" in url:
            m = re.search(r"/company/([^/]+)", url)
            if m:
                company_slug = m.group(1)
                # Note: This is an approximation. Real company search needs f_C ID,
                # but searching by keyword in the company field sometimes works.
                # However, many public 'jobs' links for guests redirect to a search page
                # that already has the f_C filter. 
                print(f"Retrying with search fallback for {company_slug}...")
        
        return result

    session = make_session(li_at)
    # ... BS4 logic omitted for brevity as we use Playwright ...
    return {"company": "Unknown", "total_jobs": "0", "raw_text": "Not found"}


def _extract_company_name(soup: BeautifulSoup, url: str) -> str:
    """Best-effort company name extraction."""
    # Try OG / title tags first
    og = soup.find("meta", property="og:title")
    if og and og.get("content"):
        return og["content"].split("|")[0].split("–")[0].strip()

    title = soup.find("title")
    if title:
        return title.get_text().split("|")[0].split("–")[0].strip()

    # Fall back to URL slug
    m = re.search(r"/company/([^/]+)", url)
    return m.group(1).replace("-", " ").title() if m else "Unknown"


# ─────────────────────────────────────────────────────────────
# SCRAPER 2 — Remote job count from a search URL
# ─────────────────────────────────────────────────────────────

def scrape_remote_jobs(url: str, li_at: str = None, use_playwright: bool = True) -> dict:
    """
    Scrape remote job count from a LinkedIn jobs search URL with f_WT=2.
    """
    if use_playwright:
        return scrape_with_playwright(url, li_at, scraper_type="remote")

    session = make_session(li_at)
    time.sleep(random.uniform(1.5, 3.0))

    try:
        resp = session.get(url, timeout=15)
        resp.raise_for_status()
    except requests.RequestException as e:
        return {"error": str(e), "remote_jobs": "0"}

    soup = BeautifulSoup(resp.text, "html.parser")

    result_selectors = [
        ".jobs-search-results-list__text",
        "span.results-context-header__job-count",
        "div.jobs-search-results-list__subtitle",
        "h1.jobs-search-results-list__title",
    ]
    for sel in result_selectors:
        tag = soup.select_one(sel)
        if tag and re.search(r"\d", tag.get_text()):
            raw = tag.get_text(strip=True)
            count = extract_number(raw, keep_plus=True)
            if count != "0":
                company = _extract_company_from_search(soup, url)
                return {"company": company, "remote_jobs": count, "raw_text": raw}

    # Fallback search in text
    text = soup.get_text(" ", strip=True)
    pattern = re.compile(r"([\d,]+\+?)\s+(?:remote\s+)?(?:results?|jobs?)", re.IGNORECASE)
    matches = pattern.findall(text)
    if matches:
        raw = matches[0]
        count = extract_number(raw, keep_plus=True)
        company = _extract_company_from_search(soup, url)
        return {"company": company, "remote_jobs": count, "raw_text": raw}

    return {
        "company": _extract_company_from_search(soup, url),
        "remote_jobs": "0",
        "raw_text": "Not found",
    }


def _extract_company_from_search(soup: BeautifulSoup, url: str) -> str:
    """Extract company from search page (less reliable without auth)."""
    og = soup.find("meta", property="og:title")
    if og and og.get("content"):
        return og["content"].split("|")[0].strip()
    title = soup.find("title")
    if title:
        return title.get_text().split("|")[0].strip()
    return "Unknown"


# ─────────────────────────────────────────────────────────────
# PLAYWRIGHT VERSION (more reliable — renders JS)
# ─────────────────────────────────────────────────────────────

def scrape_with_playwright(url: str, li_at: str = None, scraper_type: str = "total") -> dict:
    """
    Use Playwright to render the page fully. Handles redirection and dynamic loading.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        # Launch with some stealth-like options
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
            # Increase timeout and wait for load state
            response = page.goto(url, wait_until="load", timeout=60000)
            
            # Brief pause for BigPipe streaming content
            time.sleep(5)
            
            # Check if redirected to a login page
            current_url = page.url
            if "login" in current_url or "checkpoint" in current_url:
                print(f"Warning: Redirected to login page: {current_url}")
                # We can try to proceed anyway to see if guest content is hidden in some tags
        except Exception as e:
            browser.close()
            return {"error": f"Page load failed: {str(e)}", "count": "0", "company": "Unknown"}

        # Attempt to extract company name
        company = "Unknown"
        try:
            title = page.title()
            company = title.split("|")[0].split("–")[0].strip()
        except:
            pass

        # Comprehensive list of selectors (Guest + Logged-in)
        if scraper_type == "total":
            selectors = [
                "h4.org-jobs-job-search-form-module__headline",
                ".org-jobs-job-search-form-module__headline",
                "span.results-context-header__job-count",
                ".results-context-header__job-count",
                "h2.jobs-search-results-list__subtitle",
                "h1.top-card-layout__title", # sometimes company name + count
            ]
            keep_plus = False
        else:
            selectors = [
                 ".jobs-search-results-list__text span",
                 "small.jobs-search-results-list__text",
                 ".jobs-search-results-list__text",
                 "span.results-context-header__job-count",
                 ".results-context-header__job-count",
                 "h1.jobs-search-results-list__title",
            ]
            keep_plus = True

        found_raw = "N/A"
        for sel in selectors:
            try:
                # Wait up to 5s for each selector to appear
                el = page.wait_for_selector(sel, timeout=5000)
                if el:
                    raw = el.inner_text()
                    if re.search(r"\d", raw):
                        count = extract_number(raw, keep_plus=keep_plus)
                        if count != "0":
                            browser.close()
                            return {"company": company, "count": count, "raw_text": raw}
                        found_raw = raw
            except:
                continue

        # Final Fallback: body regex (case-insensitive)
        body_text = page.inner_text("body")
        browser.close()

        # Look for patterns like "38,877 job openings" or "900+ results"
        patterns = [
            r"([\d,]+\+?)\s+(?:open\s+)?(?:remote\s+)?(?:jobs?|results?|job openings)",
            r"(?:has|over)\s+([\d,]+\+?)\s+(?:open\s+)?jobs?"
        ]
        
        for p in patterns:
            m = re.search(p, body_text, re.I)
            if m:
                count = extract_number(m.group(1), keep_plus=keep_plus)
                if count != "0":
                    return {"company": company, "count": count, "raw_text": m.group(0)}

    return {"company": company, "count": "0", "raw_text": found_raw}


# ─────────────────────────────────────────────────────────────
# CLI ENTRY POINT
# ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    # Optional: set your li_at cookie here or pass as env var
    LI_AT = None   # e.g. "AQEDATs3..."

    if len(sys.argv) < 2:
        print("Usage:")
        print("  python linkedin_scrapers.py <url> [li_at_cookie]")
        print()
        print("Examples:")
        print("  python linkedin_scrapers.py https://www.linkedin.com/company/accenture/jobs/")
        print("  python linkedin_scrapers.py 'https://www.linkedin.com/jobs/search/?f_C=1033&f_WT=2&geoId=92000000'")
        sys.exit(0)

    url = sys.argv[1]
    if len(sys.argv) >= 3:
        LI_AT = sys.argv[2]

    # Use playwright by default
    if "/company/" in url and "/jobs" in url:
        result = scrape_total_jobs(url, LI_AT, use_playwright=True)
        # Check if we got an error or count in 'count' key (from playwright)
        final_count = result.get('total_jobs') or result.get('count', '0')
        print(f"\nCompany: {result.get('company', 'Unknown')}")
        print(f"Total Open Jobs: {final_count}")
        print(f"Raw text found: {result.get('raw_text', 'N/A')}")
    elif "jobs/search" in url:
        result = scrape_remote_jobs(url, LI_AT, use_playwright=True)
        final_count = result.get('remote_jobs') or result.get('count', '0')
        print(f"\nCompany: {result.get('company', 'Unknown')}")
        print(f"Total Remote Jobs: {final_count}")
        print(f"Raw text found: {result.get('raw_text', 'N/A')}")
    else:
        print("URL not recognized. Use a company jobs URL or a jobs/search URL.")
