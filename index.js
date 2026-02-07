const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

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

async function getBinancePrice(symbol) {
    try {
        const cleanSymbol = symbol.toUpperCase().replace(/[\/\s-]/g, '');
        const url = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${cleanSymbol}`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json();
        return data && data.price ? parseFloat(data.price) : null;
    } catch (error) {
        return null;
    }
}

async function makeClaudeRequest(systemPrompt, userPrompt, temperature = 0.1) {
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
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Claude API error: ${err}`);
    }
    return await response.json();
}

async function searchMarketData(query) {
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
        });
        return await response.json();
    } catch (err) {
        return { error: "Search failed", results: [] };
    }
}

// --- Main Analyst Bot Logic ---

app.post('/', async (req, res) => {
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
            const p = await getBinancePrice(sym);
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
        const auditRes = await makeClaudeRequest("Sen Deneyimli bir Portföy Risk Yöneticisisin. Hesaplamalar için HER ZAMAN sağlanan GÜNCEL PİYASA FİYATLARINI (CURRENT MARKET PRICES) kullan. Tüm açıklamaların TÜRKÇE olsun.", auditPrompt, 0.2);

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
        const planRes = await makeClaudeRequest("Sen Baş Kıdemli Finansal Araştırmacısın. Tüm araştırma adımlarını TÜRKÇE planla.", planPrompt, 0.2);
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
            const queryToUse = step.searchQuery || userQuery;
            console.log(`[Analyst] Executing Research Step: ${step.description}`);
            const data = await searchMarketData(queryToUse);

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
            const tickerRes = await makeClaudeRequest("You are a data extractor. Output JSON only.", tickerPrompt, 0.1);
            const tickerData = extractJSON(tickerRes.content[0].text);
            newCandidates = tickerData.candidate_tickers || [];
        } catch (e) {
            console.warn(`[Analyst] Failed to extract tickers: ${e.message}`);
        }

        // Fetch prices for new candidates if we don't have them
        let newPricesAdded = 0;
        for (const sym of newCandidates) {
            const cleanSym = sym.toUpperCase().trim();
            if (!priceMap[cleanSym]) {
                const p = await getBinancePrice(cleanSym);
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
        const usdt = usdtObj ? usdtObj.free : 200;

        const totalEquity = (context.userPositions?.reduce((sum, p) => sum + parseFloat(p.unrealizedProfit || 0), 0) || 0) + parseFloat(usdt);
        const budget = Math.max(15, totalEquity * 0.1);

        const systemPrompt = `InvestAI Sentez Merkezi (2026). Bütçe: $${budget.toFixed(2)}. Güncel Fiyatlar: ${priceContext}. Son derece öz, mantıklı ve TÜRKÇE konuş. Yanıtını \`\`\`json\`\`\` bloğuyla bitir.`;
        const synthesisPrompt = `
Goal: ${userQuery}
Verified Prices: ${priceContext}
Audit Findings: ${auditData.audit_findings}
Adjustments Needed: ${JSON.stringify(auditData.recommended_adjustments)}
Market Research: ${JSON.stringify(stepResults).substring(0, 25000)}
Portfolio: ${JSON.stringify(context)}

Verdict & JSON Block:
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
        "suggested_quantity": 0
      }
    ]
  }
}
\`\`\`
Not: "suggested_quantity", sistemin varsayılan güvenlik bütçesini kullanmasını istiyorsanız 0 olabilir.
KRİTİK: TP ve SL değerlerini bağlamda sağlanan "Güncel Fiyatlar" (Current Prices) üzerinden hesaplayın. Fiyat uydurmayın.
CLOSE (KAPAT) işlemleri için kaldıraç/SL/TP dikkate alınmaz.
TÜM METİNLER TÜRKÇE OLMALIDIR.
`;

        const finalRes = await makeClaudeRequest(systemPrompt, synthesisPrompt, 0.4);
        const finalText = finalRes.content[0].text;
        console.log(`[Analyst] Response Length: ${finalText.length}`);

        const rawData = extractJSON(finalText);

        // 4. Validate Recommendations
        const tradeRecommendations = [];
        for (const r of (rawData.data?.recommendations || [])) {
            const rawAction = (r.action || '').toUpperCase();
            if (rawAction === 'HOLD' || rawAction === 'STAY') continue;

            // Normalize Action Mapping
            let normalizedAction = 'HOLD';
            if (rawAction.includes('BUY') || rawAction.includes('LONG') || rawAction.includes('AL')) {
                normalizedAction = 'BUY';
            } else if (rawAction.includes('SELL') || rawAction.includes('SHORT') || rawAction.includes('SAT')) {
                normalizedAction = 'SELL';
            } else if (rawAction.includes('CLOSE') || rawAction.includes('EXIT') || rawAction.includes('KAPAT')) {
                normalizedAction = 'CLOSE';
            } else if (rawAction.includes('UPDATE') || rawAction.includes('GÜNCELLE') || rawAction.includes('MODIFY')) {
                normalizedAction = 'UPDATE';
            }

            if (normalizedAction === 'HOLD') {
                console.log(`[Analyst] Skipping non-trade action: ${rawAction} for ${r.asset}`);
                continue;
            }

            const livePrice = await getBinancePrice(r.asset);
            if (livePrice) {
                // If AI suggested a specific quantity, use it. Otherwise calculate based on budget.
                const finalQuantity = normalizedAction === 'UPDATE' ? 0 : (r.suggested_quantity > 0
                    ? parseFloat(r.suggested_quantity)
                    : parseFloat((budget / livePrice).toFixed(4)));

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
        console.error(`[Error]`, error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Analyst Server live on ${PORT}`);
});