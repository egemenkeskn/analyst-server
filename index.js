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
        const cleanStr = str.replace(/\/\/.*$/gm, '').trim();
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
            model: "claude-sonnet-4-5",
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

        if (!userQuery || userQuery === 'undefined' || userQuery === 'null') {
            userQuery = "Optimize my portfolio based on current 2026 market conditions.";
        }

        console.log(`[Analyst] Processing Goal: ${userQuery}`);

        // --- PHASE 0: Price Injection ---
        console.log(`[Analyst] Phase 0: Fetching Real-Time Prices...`);
        const assetsToHalt = ['BTCUSDT', 'ETHUSDT', 'PAXGUSDT'];
        const priceMap = {};
        for (const sym of assetsToHalt) {
            const p = await getBinancePrice(sym);
            if (p) priceMap[sym] = p;
        }
        const priceContext = Object.entries(priceMap).map(([s, p]) => `${s}: $${p}`).join(', ');
        console.log(`[Analyst] Injected Price Context: ${priceContext}`);

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

Output ONLY a JSON object:
{
  "audit_findings": "Summary of current portfolio health and immediate needs",
  "recommended_adjustments": ["Asset names to close or reduce", "..."]
}
`;
        const auditRes = await makeClaudeRequest("You are a Senior Portfolio Risk Manager. ALWAYS use the provided CURRENT MARKET PRICES for calculations.", auditPrompt, 0.2);
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

Output ONLY a JSON object:
{
  "steps": [
    {
      "action": "market_search",
      "description": "Short reasoning",
      "searchQuery": "Optimized search string"
    }
  ]
}
`;
        const planRes = await makeClaudeRequest("You are a Lead Financial Researcher.", planPrompt, 0.2);
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
            stepResults.push({ step: step.description, query: queryToUse, data });
        }

        // --- PHASE 4: Final Synthesis ---
        const usdt = context.userBalances?.find(b => b.asset === 'USDT')?.free || 200;
        const totalEquity = (context.userPositions?.reduce((sum, p) => sum + parseFloat(p.unrealizedProfit || 0), 0) || 0) + parseFloat(usdt);
        const budget = Math.max(15, totalEquity * 0.1);

        const systemPrompt = `InvestAI Synthesis Core (2026). Budget: $${budget.toFixed(2)}. Current Prices: ${priceContext}. Be extremely concise and logical. End with JSON in \`\`\`json\`\`\`.`;
        const synthesisPrompt = `
Goal: ${userQuery}
Verified Prices: ${priceContext}
Audit Findings: ${auditData.audit_findings}
Adjustments Needed: ${JSON.stringify(auditData.recommended_adjustments)}
Market Research: ${JSON.stringify(stepResults).substring(0, 4000)}
Portfolio: ${JSON.stringify(context)}

Verdict & JSON Block:
\`\`\`json
{
  "type": "analysis_result", 
  "data": {
    "text": "A narrative explainining Phase 1 audit and Phase 2 research results. Explicitly mention current price context to reassure the user.", 
    "recommendations": [
      {
        "action": "AL/SAT/KAPAT", 
        "asset": "BTCUSDT", 
        "risk_level": "LOW", 
        "reasoning_summary": "...", 
        "suggested_price": 0, 
        "suggested_quantity": 0
      }
    ]
  }
}
\`\`\`
Note: "suggested_quantity" can be 0 if you want the system to use the default safety budget, or a specific number to override it (e.g. for flipping a position).
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
            }

            if (normalizedAction === 'HOLD') {
                console.log(`[Analyst] Skipping non-trade action: ${rawAction} for ${r.asset}`);
                continue;
            }

            const livePrice = await getBinancePrice(r.asset);
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
