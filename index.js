const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Increase server timeout for long-running analysis (5 minutes)
const SERVER_TIMEOUT = 5 * 60 * 1000; // 5 minutes in milliseconds

const PORT = process.env.PORT || 3000;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const TAVILY_API_URL = 'https://api.tavily.com/search';

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- Helpers ---

const extractJSON = (str) => {
    try {
        // DÜZELTME: URL'leri (https://) yorum satırı sanıp silen regex kaldırıldı.
        const cleanStr = str.trim();
        const marker = '"type": "analysis_result"';

        if (cleanStr.includes(marker)) {
            const start = cleanStr.lastIndexOf('{', cleanStr.indexOf(marker));
            let balance = 0;
            for (let i = start; i < cleanStr.length; i++) {
                if (cleanStr[i] === '{') balance++;
                if (cleanStr[i] === '}') balance--;
                if (balance === 0) {
                    return JSON.parse(cleanStr.substring(start, i + 1));
                }
            }
        }

        const match = cleanStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match && match[1]) return JSON.parse(match[1]);

        const firstOpen = cleanStr.indexOf('{');
        const lastClose = cleanStr.lastIndexOf('}');
        if (firstOpen !== -1 && lastClose !== -1) {
            return JSON.parse(cleanStr.substring(firstOpen, lastClose + 1));
        }

        throw new Error("No JSON found");
    } catch (e) {
        console.error(`[Parser Error] Length: ${str.length}. Preview: ${str.substring(0, 200)}`);
        throw new Error(`JSON Extraction failed: ${e.message}`);
    }
};

async function getBinancePrice(symbol, signal) {
    try {
        const cleanSymbol = symbol.toUpperCase().replace(/[\/\s-]/g, '');
        const url = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${cleanSymbol}`;
        const response = await fetch(url, { signal });
        if (!response.ok) return null;
        const data = await response.json();
        return data && data.price ? parseFloat(data.price) : null;
    } catch (error) {
        return null;
    }
}

async function makeClaudeRequest(systemPrompt, userPrompt, temperature = 0.1, signal) {
    console.log(`[Analyst] Calling Claude 4.5 Sonnet...`);
    const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
            'x-api-key': CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: "claude-sonnet-4-5", // Model ismi güncel API'ye uygun hale getirildi (veya elinizdeki spesifik model)
            max_tokens: 4000,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
            temperature,
        }),
        signal: signal || AbortSignal.timeout(120000) // User signal OR default timeout
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Claude API error: ${err}`);
    }
    return await response.json();
}

async function searchMarketData(query, signal) {
    try {
        console.log(`[Tavily API] Deep Search: ${query}...`);
        const response = await fetch(TAVILY_API_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                api_key: TAVILY_API_KEY,
                query: query,
                search_depth: "advanced",
                max_results: 5,
                include_answer: true
            }),
            signal
        });
        return await response.json();
    } catch (err) {
        return { error: "Search failed", results: [] };
    }
}

// --- Main Analyst Bot Logic ---

app.post('/', async (req, res) => {
    // Set timeout for this specific request
    req.setTimeout(SERVER_TIMEOUT);
    res.setTimeout(SERVER_TIMEOUT);

    // Create AbortController for this request
    const controller = new AbortController();
    const { signal } = controller;

    // Listen for response stream close (more reliable than req 'close' for disconnects)
    res.on('close', () => {
        if (!res.writableEnded) {
            console.log('[Analyst] Response stream closed prematurely (Client disconnect), aborting...');
            controller.abort();
        }
    });

    try {
        let { userQuery, userBalances, userPositions, userId } = req.body;

        // DÜZELTME 1: "today" değişkenini tanımla
        const today = new Date().toISOString().split('T')[0];

        // DÜZELTME 2: "context" objesini oluştur (Prompt içinde kullanılıyor)
        const context = {
            userBalances: userBalances || [],
            userPositions: userPositions || [],
            userId: userId || 'anonymous'
        };

        if (!userQuery || userQuery === 'undefined' || userQuery === 'null') {
            userQuery = "Optimize my portfolio based on current 2026 market conditions.";
        }

        console.log(`[Analyst] Processing Goal: ${userQuery}`);

        // --- PHASE 0: Context Aware Price Injection ---
        console.log(`[Analyst] Phase 0: Fetching Real-Time Prices for Context...`);

        // 1. Start with Benchmarks
        const trackedAssets = new Set(['BTCUSDT', 'ETHUSDT']);

        // 2. Add User's Current Holdings
        if (context.userPositions && context.userPositions.length > 0) {
            context.userPositions.forEach(p => {
                if (p.symbol) trackedAssets.add(p.symbol);
            });
        }

        const priceMap = {};
        for (const sym of trackedAssets) {
            if (signal.aborted) throw new Error('Aborted');
            const p = await getBinancePrice(sym, signal);
            if (p) priceMap[sym] = p;
        }

        // Initial Context String
        let priceContext = Object.entries(priceMap).map(([s, p]) => `${s}: $${p}`).join(', ');
        console.log(`[Analyst] Initial Price Context: ${priceContext}`);

        // --- PHASE 1: Portfolio Audit ---
        console.log(`[Analyst] Phase 1: Auditing Portfolio...`);
        const auditPrompt = `
Today is ${today}. 
CURRENT MARKET PRICES: ${priceContext}
USER GOAL: "${userQuery}"
PORTFOLIO: ${JSON.stringify(context)}

Analyze the current portfolio status using the verified MARKET PRICES above.
1. Evaluate open positions (PnL, Risk, Size). Use the provided Prices to calculate current value.
2. Check available USDT liquidity.
3. Identify if any existing positions are in immediate danger or should be closed.

Output ONLY a JSON object IN TURKISH:
{
  "audit_findings": "Portföyün genel durumu, kâr/zarar analizi ve acil ihtiyaçların özeti (Türkçe)",
  "recommended_adjustments": ["Kapatılması veya azaltılması gereken varlıklar", "..."]
}
`;
        const auditRes = await makeClaudeRequest("Sen Deneyimli bir Portföy Risk Yöneticisisin. Hesaplamalar için HER ZAMAN sağlanan GÜNCEL PİYASA FİYATLARINI (CURRENT MARKET PRICES) kullan. Tüm açıklamaların TÜRKÇE olsun.", auditPrompt, 0.2, signal);

        // Hata Yönetimi: Claude response content kontrolü
        if (!auditRes.content || !auditRes.content[0]) throw new Error("Claude Empty Response");

        const auditContent = auditRes.content[0].text;
        let auditData;
        try { auditData = extractJSON(auditContent); }
        catch (e) { auditData = { audit_findings: "Could not perform detailed audit, proceeding with caution.", recommended_adjustments: [] }; }

        // --- PHASE 2: Research Planning ---
        console.log(`[Analyst] Phase 2: Planning Multi-Asset Research...`);
        const planPrompt = `
Today is ${today}. 
USER GOAL: "${userQuery}"
PORTFOLIO AUDIT: "${auditData.audit_findings}"

You are a Global Macro Researcher. We trade Crypto AND Precious Metals/Commodities (Gold, Silver, etc. via Binance/PAXG).
Based on the audit and the goal, generate a research plan with 2 targeted, high-intent search queries for Tavily.
DO NOT use the user goal itself as a search query. 
Focus on finding data for:
1. Crypto price action and technical trends.
2. Precious Metals (Gold/Silver) trends or Macro/Commodity catalysts.

Output ONLY a JSON object IN TURKISH:
{
  "steps": [
    {
      "action": "market_search",
      "description": "Kısa gerekçe (Türkçe)",
      "searchQuery": "Optimize edilmiş arama sorgusu"
    }
  ]
}
`;
        const planRes = await makeClaudeRequest("Sen Baş Kıdemli Finansal Araştırmacısın. Tüm araştırma adımlarını TÜRKÇE planla.", planPrompt, 0.2, signal);
        const planContent = planRes.content[0].text;
        let planData;
        try { planData = extractJSON(planContent); }
        catch (e) {
            planData = {
                steps: [
                    { action: 'market_search', description: 'Technical analysis', searchQuery: `${userQuery} 2026 technical analysis` },
                    { action: 'market_search', description: 'Macro news', searchQuery: `crypto macro news 2026` }
                ]
            };
        }

        // --- PHASE 3: Execution of Research ---
        const stepResults = [];
        const steps = (planData.steps || []).slice(0, 2);
        for (const step of steps) {
            if (signal.aborted) throw new Error('Aborted');
            const queryToUse = step.searchQuery || userQuery;
            console.log(`[Analyst] Executing Research Step: ${step.description}`);
            const data = await searchMarketData(queryToUse, signal);

            // Optimization: Filter Tavily results to save tokens and improve context quality
            const cleanData = {
                results: (data.results || []).map(r => ({
                    title: r.title,
                    url: r.url,
                    content: r.content, // Summary/Snippet
                    published_date: r.published_date
                }))
            };

            stepResults.push({ step: step.description, query: queryToUse, data: cleanData });
        }

        // --- PHASE 3.5: Dynamic Price Discovery (NEW) ---
        console.log(`[Analyst] Phase 3.5: Identifying Interest Assets & Fetching Prices...`);
        // Ask LLM which assets are relevant based on research
        const tickerPrompt = `
Based on the User Goal and the Market Research data below, list up to 5 ticker symbols (e.g. BTCUSDT, SOLUSDT, PAXGUSDT) that are relevant candidates for trading or analysis.
Start with the obvious ones mentioned in the research.
Research Data: ${JSON.stringify(stepResults).substring(0, 15000)}

Output ONLY a JSON object:
{
  "candidate_tickers": ["BTCUSDT", "ETHUSDT", ...]
}
`;
        let newCandidates = [];
        try {
            const tickerRes = await makeClaudeRequest("You are a data extractor. Output JSON only.", tickerPrompt, 0.1, signal);
            const tickerData = extractJSON(tickerRes.content[0].text);
            newCandidates = tickerData.candidate_tickers || [];
        } catch (e) {
            if (e.name === 'AbortError' || signal.aborted) throw e;
            console.warn(`[Analyst] Failed to extract tickers: ${e.message}`);
        }

        // Fetch prices for new candidates if we don't have them
        let newPricesAdded = 0;
        for (const sym of newCandidates) {
            if (signal.aborted) throw new Error('Aborted');
            const cleanSym = sym.toUpperCase().trim();
            if (!priceMap[cleanSym]) {
                const p = await getBinancePrice(cleanSym, signal);
                if (p) {
                    priceMap[cleanSym] = p;
                    newPricesAdded++;
                }
            }
        }

        // Re-generate price context string with ALL known prices
        priceContext = Object.entries(priceMap).map(([s, p]) => `${s}: $${p}`).join(', ');
        console.log(`[Analyst] Updated Price Context (+${newPricesAdded} new): ${priceContext}`);


        // --- PHASE 4: Final Synthesis ---
        // Context güvenliği: userBalances undefined ise hata vermesin
        const usdtObj = context.userBalances ? context.userBalances.find(b => b.asset === 'USDT') : null;
        const usdt = parseFloat(usdtObj ? usdtObj.free : 200);

        const totalEquity = (context.userPositions?.reduce((sum, p) => sum + parseFloat(p.unrealizedProfit || 0), 0) || 0) + usdt;
        const budget = Math.max(15, totalEquity * 0.1);


        const systemPrompt = `InvestAI Sentez Merkezi (2026). 
**KRİTİK BAKIYE KISITI:** 
- Kullanıcının mevcut USDT bakiyesi: $${usdt.toFixed(2)}
- Maksimum tek pozisyon büyüklüğü: $${budget.toFixed(2)} (bakiyenin %10'u)
- TÜM yeni pozisyonların TOPLAM marj gereksinimi ${usdt.toFixed(2)} USDT'yi aşmamalıdır.
- Eğer bakiye yetersizse, daha küçük pozisyon boyutları önerin veya hiç pozisyon açma.

**BİNANCE İŞLEM KURALLARI (ZOD STRICT):**
1. **Minimum Notional Value:**
   - BTC/ETH/BNB için: En az 5 USDT değerinde işlem
   - Diğer tüm coinler için: En az 20 USDT değerinde işlem
   - Formül: (quantity × price) &&ge; MinimumNotional
   - UYARI: 20 USDT'den küçük işlem önerme, reddedilir!

2. **Quantity Validation:**
   - suggested_quantity ASLA 0 (sıfır) olamaz
   - suggested_quantity &&gt; 0 olmalı
   - Zero quantity = Binance API hatası

3. **Balance Sufficiency:**
   - Her pozisyon için margin gereksinimi: (quantity × price) / leverage
   - Toplam margin &&lt; ${usdt.toFixed(2)} USDT
   - Eğer yetersizse quantity'yi azalt VEYA önerme

Güncel Fiyatlar: ${priceContext}. 
Son derece öz, mantıklı ve TÜRKÇE konuş. Yanıtını \`\`\`json\`\`\` bloğuyla bitir.`;

        const synthesisPrompt = `
Goal: ${userQuery}
**AVAILABLE USDT BALANCE: $${usdt.toFixed(2)}** 
**MAX POSITION SIZE PER TRADE: $${budget.toFixed(2)}**
**CRITICAL: Total margin requirement for ALL new positions MUST NOT exceed $${usdt.toFixed(2)} USDT.**

Verified Prices: ${priceContext}
Audit Findings: ${auditData.audit_findings}
Adjustments Needed: ${JSON.stringify(auditData.recommended_adjustments)}
Market Research: ${JSON.stringify(stepResults).substring(0, 25000)}
Portfolio: ${JSON.stringify(context)}

**BINANCE VALIDATION CHECKLIST (MANDATORY):**
Before recommending ANY trade, validate:
1. ✅ Quantity &&gt; 0 (NEVER suggest 0 quantity)
2. ✅ Notional Value = quantity × ${priceContext} &&ge; Minimum (5 USDT for BTC/ETH/BNB, 20 USDT otherwise)
3. ✅ Total margin for all positions = Σ(quantity × price) / leverage &&lt; ${usdt.toFixed(2)} USDT
4. ✅ If validation fails, reduce quantity OR skip recommendation

**EXAMPLE CALCULATION:**
- ETHUSDT price: Find in Verified Prices above
- If suggesting 0.01 ETH at $3000: Notional = 0.01 × 3000 = $30 USDT ✅ (exceeds 5 USDT minimum)
- If suggesting 0.005 BTC at $100k: Notional = 0.005 × 100000 = $500 USDT ✅
- If suggesting 0.5 SOLUSDT at $30: Notional = 0.5 × 30 = $15 USDT ❌ (below 20 USDT, REJECT)

**BALANCE CHECK BEFORE RECOMMENDING:**
- Calculate required margin for each position: (quantity × price) / leverage
- Sum all new positions' required margin
- If total &&gt; ${usdt.toFixed(2)} USDT, reduce quantity or skip recommendations

Verdict &&amp; JSON Block:
\`\`\`json
{
  "type": "analysis_result", 
  "data": {
    "text": "Faz 1 denetimini ve Faz 2 araştırma sonuçlarını açıklayan akıcı bir anlatım. Kullanıcıyı rahatlatmak için mevcut fiyat bağlamından açıkça bahsedin. TÜRKÇE yazın.", 
    "recommendations": [
      {
        "action": "AL/SAT/KAPAT", 
        "asset": "BTCUSDT", 
        "leverage": 1, 
        "stop_loss": 0, 
        "take_profit": 0, 
        "risk_level": "LOW", 
        "reasoning_summary": "Bu işlem için TÜRKÇE kısa gerekçe.", 
        "suggested_price": 0, 
        "suggested_quantity": 0.001
      }
    ]
  }
}
\`\`\`
Not: "suggested_quantity" ASLA 0 olmamalı. Minimum notional value kurallarını takip et.
KRİTİK: TP ve SL değerlerini bağlamda sağlanan "Güncel Fiyatlar" (Current Prices) üzerinden hesaplayın. Fiyat uydurmayın.
CLOSE (KAPAT) işlemleri için kaldıraç/SL/TP dikkate alınmaz.
TÜM METİNLER TÜRKÇE OLMALIDIR.
NOT: Mevcut açık pozisyonların TP/SL değerlerini GÜNCELLEME. TP ve SL değerleri SADECE yeni açılan (AL/SAT) pozisyonlar için verilmelidir. Mevcut pozisyonlar için sadece "KAPAT" veya "BEKLE" kararı ver.
`;

        const finalRes = await makeClaudeRequest(systemPrompt, synthesisPrompt, 0.4, signal);
        const finalText = finalRes.content[0].text;
        console.log(`[Analyst] Response Length: ${finalText.length}`);

        const rawData = extractJSON(finalText);

        // 4. Validate Recommendations
        const tradeRecommendations = [];
        for (const r of (rawData.data?.recommendations || [])) {
            const rawAction = (r.action || '').toUpperCase();
            if (rawAction === 'HOLD' || rawAction === 'STAY') continue;

            if (signal.aborted) throw new Error('Aborted');

            // Normalize Action Mapping
            let normalizedAction = 'HOLD';
            if (rawAction.includes('BUY') || rawAction.includes('LONG') || rawAction.includes('AL')) {
                normalizedAction = 'BUY';
            } else if (rawAction.includes('SELL') || rawAction.includes('SHORT') || rawAction.includes('SAT')) {
                normalizedAction = 'SELL';
            } else if (rawAction.includes('CLOSE') || rawAction.includes('EXIT') || rawAction.includes('KAPAT')) {
                normalizedAction = 'CLOSE';
            }

            if (normalizedAction === 'HOLD') {
                console.log(`[Analyst] Skipping non-trade action: ${rawAction} for ${r.asset}`);
                continue;
            }

            const livePrice = await getBinancePrice(r.asset, signal); // Optional: check signal here too if needed
            if (livePrice) {
                // If AI suggested a specific quantity, use it. Otherwise calculate based on budget.
                const finalQuantity = r.suggested_quantity > 0
                    ? parseFloat(r.suggested_quantity)
                    : parseFloat((budget / livePrice).toFixed(4));

                tradeRecommendations.push({
                    symbol: r.asset,
                    action: normalizedAction,
                    originalAction: rawAction,
                    quantity: finalQuantity,
                    leverage: Math.min(Math.max(r.leverage || 1, 1), 20), // Cap between 1x and 20x
                    stopLoss: r.stop_loss || 0,
                    takeProfit: r.take_profit || 0,
                    reason: r.reasoning_summary,
                    confidence: 0.9,
                    price: r.suggested_price || livePrice
                });
            }
        }

        res.json({
            text: rawData.data?.text || "Analysis Complete",
            tradeRecommendations,
            plan: planData
        });



    } catch (error) {
        if (error.name === 'AbortError' || error.message === 'Aborted') {
            console.log('[Analyst] Process aborted successfully.');
            if (!res.headersSent) {
                res.status(499).json({ error: 'canceled' });
            }
        } else {
            console.error(`[Error]`, error);
            if (!res.headersSent) {
                res.status(500).json({ error: error.message });
            }
        }
    }
});

app.listen(PORT, () => {
    console.log(`Analyst Server live on ${PORT}`);
});