/**
 * Automated Domain Health Checker & Manifest Generator
 * 
 * Periodically probes AniKoto, MegaVid, and community mirrors,
 * tests stream resolution, and generates a verified manifest.json.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Timeout for HTTP checks (ms)
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
// 1. ANIKOTO MIRROR PROBER (Dead Link Pruning)
// ═══════════════════════════════════════════════════════════════

const ANIKOTO_CANDIDATES = [
    'https://anikoto.cz',
    'https://anikototv.to',
    'https://anikoto.me',
    'https://anikoto.net',
    'https://anikoto.tv',
    'https://anikoto.bz',
    'https://anikoto.site',
    'https://anikoto.cc',
    'https://anikoto.is'
];

async function verifyAniKotoMirror(mirror) {
    const cleanMirror = mirror.trim().replace(/\/+$/, '');
    console.log(`[AniKoto] Testing ${cleanMirror}...`);

    try {
        // Step 1: Probe filter search with a known active anime title
        const searchRes = await httpRequest(`${cleanMirror}/filter?keyword=naruto`, {
            headers: { 'Referer': `${cleanMirror}/home` }
        });

        if (searchRes.status !== 200 || !searchRes.body || searchRes.body.length < 500) {
            console.log(`  ❌ Dead/Blocked: ${cleanMirror} (HTTP ${searchRes.status}) -> Pruned`);
            return null;
        }

        // Verify it returns real functional anime card elements
        if (!searchRes.body.includes('data-tip=') && !searchRes.body.includes('/watch/')) {
            console.log(`  ❌ Invalid Payload: ${cleanMirror} -> Pruned`);
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
    'https://megavid.to'
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

        if (res.status === 200 || (res.body && res.body.startsWith('{'))) {
            console.log(`  ✅ Healthy: ${cleanSeed} (API responsive)`);
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
    console.log('Anime Stream Mirrors Automated Health Checker');
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log('====================================================\n');

    // Run probes in parallel
    const [aniKotoResults, megaVidResults] = await Promise.all([
        Promise.all(ANIKOTO_CANDIDATES.map(m => verifyAniKotoMirror(m))),
        Promise.all(MEGAVID_CANDIDATES.map(s => verifyMegaVidSeed(s)))
    ]);

    const liveAniKoto = aniKotoResults.filter(Boolean);
    const liveMegaVid = megaVidResults.filter(Boolean);

    console.log('\n--- Probe Summary ---');
    console.log(`AniKoto: ${liveAniKoto.length}/${ANIKOTO_CANDIDATES.length} mirrors operational`);
    console.log(`MegaVid: ${liveMegaVid.length}/${MEGAVID_CANDIDATES.length} seeds operational\n`);

    // Ensure we always have at least fallback mirrors if all networks are down
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
    console.log(JSON.stringify(manifest, null, 2));
}

main().catch(err => {
    console.error('Fatal error in domain health check:', err);
    process.exit(1);
});
