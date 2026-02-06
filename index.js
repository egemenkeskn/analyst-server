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

        let context = { userBalances: userBalances || [], userPositions: userPositions || [] };
        const today = new Date().toISOString().split('T')[0];

        // 1. Research Plan
        const planPrompt = `Today: ${today} (2026). Goal: "${userQuery}". Output ONLY JSON: {"steps": [{"action": "market_search", "description": "...", "searchQuery": "..."}]}`;
        const planRes = await makeClaudeRequest("You are a Lead Financial Researcher.", planPrompt);
        const planContent = planRes.content[0].text;

        let planData;
        try { planData = extractJSON(planContent); }
        catch (e) { planData = { steps: [{ action: 'market_search', searchQuery: userQuery }] }; }

        // 2. Execute Steps
        const stepResults = [];
        for (const step of (planData.steps || []).slice(0, 2)) {
            console.log(`[Analyst] Step: ${step.description}`);
            const data = await searchMarketData(step.searchQuery || userQuery);
            stepResults.push({ step: step.description, data });
        }

        // 3. Synthesis
        const usdt = context.userBalances?.find(b => b.asset === 'USDT')?.free || 200;
        const totalEquity = (context.userPositions?.reduce((sum, p) => sum + parseFloat(p.unrealizedProfit || 0), 0) || 0) + parseFloat(usdt);
        const budget = Math.max(15, totalEquity * 0.1);

        const systemPrompt = `InvestAI Core (2026). Budget: $${budget.toFixed(2)}. Be extremely concise. End with JSON in \`\`\`json\`\`\`.`;
        const synthesisPrompt = `
            Goal: ${userQuery}
            Research: ${JSON.stringify(stepResults).substring(0, 4000)}
            Portfolio: ${JSON.stringify(context)}
            Verdict & JSON Block:
            \`\`\`json
            {"type": "analysis_result", "data": {"text": "...", "recommendations": [{"action": "BUY_NEW", "asset": "BTCUSDT", "risk_level": "LOW", "reasoning_summary": "...", "suggested_price": 0, "suggested_quantity": 0}]}}
            \`\`\`
        `;

        const finalRes = await makeClaudeRequest(systemPrompt, synthesisPrompt, 0.4);
        const finalText = finalRes.content[0].text;
        console.log(`[Analyst] Response Length: ${finalText.length}`);

        const rawData = extractJSON(finalText);

        // 4. Validate Recommendations
        const tradeRecommendations = [];
        for (const r of (rawData.data?.recommendations || [])) {
            if (r.action === 'HOLD') continue;
            const livePrice = await getBinancePrice(r.asset);
            if (livePrice) {
                tradeRecommendations.push({
                    symbol: r.asset,
                    action: r.action,
                    quantity: parseFloat((budget / livePrice).toFixed(4)),
                    reason: r.reasoning_summary,
                    confidence: 0.9,
                    price: livePrice
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
