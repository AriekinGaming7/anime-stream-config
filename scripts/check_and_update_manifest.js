/**
 * Automated Domain Health Checker, Crawler & Manifest Generator
 * 
 * 1. Crawls official domain hubs (e.g. anikoto.site).
 * 2. Resolves HTTP 301/302 redirectors (e.g. anikoto.bz -> anikototv.to).
 * 3. Sweeps known TLD mirror candidates.
 * 4. Verifies genuine search & stream extraction on every discovered server.
 * 5. Prunes dead / offline / parked domains.
 * 6. Generates a fresh, verified manifest.json for the Android app.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Timeout for HTTP requests (ms)
const TIMEOUT_MS = 6000;

function httpRequest(url, options = {}) {
    return new Promise((resolve) => {
        try {
            const u = new URL(url);
            const lib = u.protocol === 'https:' ? https : http;
            const req = lib.request({
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: u.pathname + u.search,
                method: options.method || 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/json,*/*',
                    ...(options.headers || {})
                },
                timeout: TIMEOUT_MS
            }, (res) => {
                let body = '';
                res.on('data', (chunk) => body += chunk);
                res.on('end', () => {
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: body
                    });
                });
            });

            req.on('error', (err) => resolve({ status: 0, error: err.message }));
            req.on('timeout', () => {
                req.destroy();
                resolve({ status: 0, error: 'timeout' });
            });
            req.end();
        } catch (e) {
            resolve({ status: 0, error: e.message });
        }
    });
}

// ═══════════════════════════════════════════════════════════════
// 1. AUTOMATED DOMAIN CRAWLER & REDIRECT RESOLVER
// ═══════════════════════════════════════════════════════════════

const OFFICIAL_HUBS = [
    'https://anikoto.site'
];

async function crawlOfficialHubs() {
    const discovered = new Set();
    console.log('[Crawler] Querying official domain hubs...');

    for (const hub of OFFICIAL_HUBS) {
        try {
            const res = await httpRequest(hub);
            if (res.status === 200 && res.body) {
                // Match links like https://anikoto... or https://anikototv...
                const matches = res.body.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)?anikoto[a-zA-Z0-9-]*\.[a-z]{2,}(?:\/)?/gi) || [];
                for (const m of matches) {
                    const clean = m.trim().replace(/\/+$/, '');
                    if (!clean.includes('site') && !clean.includes('cloudflare')) {
                        discovered.add(clean);
                    }
                }
                console.log(`  🔍 Hub ${hub} revealed:`, Array.from(discovered));
            }
        } catch (e) {
            console.log(`  ⚠️ Hub ${hub} failed:`, e.message);
        }
    }
    return Array.from(discovered);
}

// Seed candidate pools (base TLD sweep)
const BASE_ANIKOTO_CANDIDATES = [
    'https://anikoto.cz',
    'https://anikototv.to',
    'https://anikoto.me',
    'https://anikoto.net',
    'https://anikototv.se',
    'https://anikoto.tv',
    'https://anikoto.bz',
    'https://anikoto.cc',
    'https://anikoto.is',
    'https://anikoto.top',
    'https://anikoto.app',
    'https://anikoto.io',
    'https://anikoto.world'
];

async function verifyAniKotoMirror(mirror, candidateSet) {
    const cleanMirror = mirror.trim().replace(/\/+$/, '');
    console.log(`[AniKoto] Testing ${cleanMirror}...`);

    try {
        const searchRes = await httpRequest(`${cleanMirror}/filter?keyword=naruto`, {
            headers: { 'Referer': `${cleanMirror}/home` }
        });

        // Check for 301/302 redirects to automatically discover destination domain
        if ([301, 302, 307, 308].includes(searchRes.status) && searchRes.headers && searchRes.headers.location) {
            try {
                const targetUrl = new URL(searchRes.headers.location, cleanMirror);
                const targetOrigin = targetUrl.origin;
                console.log(`  ↪️ Redirect: ${cleanMirror} -> ${targetOrigin}`);
                if (!candidateSet.has(targetOrigin)) {
                    candidateSet.add(targetOrigin);
                }
            } catch (_) {}
            console.log(`  ❌ Redirector (not direct endpoint): ${cleanMirror} -> Pruned`);
            return null;
        }

        if (searchRes.status !== 200 || !searchRes.body || searchRes.body.length < 500) {
            console.log(`  ❌ Dead/Blocked: ${cleanMirror} (HTTP ${searchRes.status}) -> Pruned`);
            return null;
        }

        // Verify genuine functional anime cards returned
        if (!searchRes.body.includes('data-tip=') && !searchRes.body.includes('/watch/')) {
            console.log(`  ❌ Invalid Payload / Parked: ${cleanMirror} -> Pruned`);
            return null;
        }

        console.log(`  ✅ Healthy: ${cleanMirror} (Search API responsive)`);
        return cleanMirror;
    } catch (e) {
        console.log(`  ❌ Error: ${cleanMirror} (${e.message}) -> Pruned`);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════
// 2. MEGAVID / STREAM PROVIDER SEED PROBER
// ═══════════════════════════════════════════════════════════════

const MEGAVID_CANDIDATES = [
    'https://megavid.buzz',
    'https://megavid.cc',
    'https://megavid.to',
    'https://megavid.pro',
    'https://megavid.net'
];

async function verifyMegaVidSeed(seed) {
    const cleanSeed = seed.trim().replace(/\/+$/, '');
    console.log(`[MegaVid] Testing ${cleanSeed}...`);

    try {
        const res = await httpRequest(`${cleanSeed}/ani/100077/1/sub/source?provider=1`, {
            headers: {
                'Referer': `${cleanSeed}/`,
                'Origin': cleanSeed
            }
        });

        // Must return valid JSON containing "status" and "source"
        if (res.status === 200 && res.body && res.body.includes('"status"') && res.body.includes('"source"')) {
            console.log(`  ✅ Healthy: ${cleanSeed} (API responsive & payload verified)`);
            return cleanSeed;
        }

        console.log(`  ❌ Dead/Blocked: ${cleanSeed} (HTTP ${res.status}) -> Pruned`);
        return null;
    } catch (e) {
        console.log(`  ❌ Error: ${cleanSeed} (${e.message}) -> Pruned`);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════
// 3. MAIN RUNNER
// ═══════════════════════════════════════════════════════════════

async function main() {
    console.log('====================================================');
    console.log('Anime Stream Mirrors Automated Health & Discovery Crawler');
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log('====================================================\n');

    // Step 1: Crawl official hubs for newly published domains
    const crawledDomains = await crawlOfficialHubs();

    // Step 2: Combine base candidate pool with crawled domains
    const candidateSet = new Set([...BASE_ANIKOTO_CANDIDATES, ...crawledDomains]);

    // Step 3: Run probes across all candidates (and detect any new redirects)
    const testedCandidates = Array.from(candidateSet);
    const aniKotoResults = await Promise.all(
        testedCandidates.map(m => verifyAniKotoMirror(m, candidateSet))
    );

    // If new redirects were discovered during probe that weren't tested, test them
    for (const discovered of candidateSet) {
        if (!testedCandidates.includes(discovered)) {
            console.log(`[Discovery] Testing newly redirected mirror: ${discovered}...`);
            const res = await verifyAniKotoMirror(discovered, candidateSet);
            if (res) aniKotoResults.push(res);
        }
    }

    // Step 4: Test MegaVid seeds
    const megaVidResults = await Promise.all(
        MEGAVID_CANDIDATES.map(s => verifyMegaVidSeed(s))
    );

    const liveAniKoto = [...new Set(aniKotoResults.filter(Boolean))];
    const liveMegaVid = [...new Set(megaVidResults.filter(Boolean))];

    console.log('\n--- Discovery & Health Summary ---');
    console.log(`AniKoto: ${liveAniKoto.length} operational mirrors discovered & verified:`);
    liveAniKoto.forEach(m => console.log(`  - ${m}`));
    console.log(`MegaVid: ${liveMegaVid.length} operational seeds verified:`);
    liveMegaVid.forEach(s => console.log(`  - ${s}`));
    console.log('');

    // Fail-safe fallbacks if all networks temporarily fail
    const finalAniKoto = liveAniKoto.length > 0 ? liveAniKoto : ['https://anikoto.cz', 'https://anikototv.to'];
    const finalMegaVid = liveMegaVid.length > 0 ? liveMegaVid : ['https://megavid.buzz'];

    const manifest = {
        version: 1,
        megavid_seeds: finalMegaVid,
        anikoto_mirrors: finalAniKoto,
        sub_provider_param: "1",
        dub_provider_param: "1",
        updated_at_epoch: Date.now(),
        updated_at_utc: new Date().toISOString()
    };

    const outDir = path.resolve(__dirname, '..');
    const outPath = path.join(outDir, 'manifest.json');
    fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`✅ Generated manifest.json successfully at: ${outPath}`);
}

main().catch(err => {
    console.error('Fatal error in domain health check:', err);
    process.exit(1);
});
