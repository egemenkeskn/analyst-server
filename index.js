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
        const match = str.match(/```json\s*([\s\S]*?)\s*```/);
        if (match && match[1]) return JSON.parse(match[1].replace(/\/\/.*$/gm, ''));
        const firstOpen = str.indexOf('{');
        const lastClose = str.lastIndexOf('}');
        if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
            const candidate = str.substring(firstOpen, lastClose + 1);
            return JSON.parse(candidate.replace(/\/\/.*$/gm, ''));
        }
        return JSON.parse(str.replace(/\/\/.*$/gm, ''));
    } catch (e) {
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
            max_tokens: 4096,
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
                search_depth: "advanced", // Switched to advanced for maximum depth
                max_results: 10, // Increased from 5 to 10
                include_answer: true
            }),
        });
        return await response.json();
    } catch (err) {
        return { error: "Search failed", results: [] };
    }
}

// --- Logic from Shared Binance ---
async function getUserBinanceContext(userId) {
    const { data: userKeys } = await supabaseAdmin
        .from('user_settings')
        .select('binance_api_key, binance_api_secret')
        .eq('user_id', userId)
        .single();

    // Note: In an ideal world, we'd fetch actual balance here. 
    // For now, we'll return empty or default and rely on payload.
    return { balances: [], positions: [] };
}

// --- Main Analyst Bot Logic ---

app.post('/', async (req, res) => {
    try {
        const { userQuery, userBalances, userPositions, userId } = req.body;
        console.log(`[Analyst] New Deep Analysis Request: ${userQuery}`);

        let context = { userBalances: userBalances || [], userPositions: userPositions || [] };

        // 1. Multi-Step Research Plan
        const today = new Date().toISOString().split('T')[0];
        const planPrompt = `
            Today's Date: ${today} (Year 2026)
            User Query: "${userQuery}"
            Portfolio Stats: ${context.userBalances?.length} assets, ${context.userPositions?.length} active positions.
            
            Design a COMPREHENSIVE multi-step research plan (2-3 steps).
            Step 1 should be broad market context.
            Step 2-3 should be deep dives into specific assets or technical indicators.
            
            Output ONLY valid JSON:
            {
              "asset": "primary_asset",
              "steps": [
                { "action": "market_search", "description": "...", "searchQuery": "..." }
              ]
            }
        `;
        const planRes = await makeClaudeRequest("You are a Lead Financial Researcher. Design a deep investigation plan.", planPrompt);
        const planContent = planRes.content[0].text;

        let planData;
        try { planData = extractJSON(planContent); }
        catch (e) { planData = { steps: [{ action: 'market_search', searchQuery: userQuery }] }; }

        // 2. Execute All Steps (No time limit)
        const stepResults = [];
        for (const step of (planData.steps || []).slice(0, 3)) {
            console.log(`[Analyst] Executing Deep Step: ${step.description}`);
            const data = await searchMarketData(step.searchQuery || userQuery);
            stepResults.push({ step: step.description, data });
        }

        // 3. Maximum Capacity Synthesis
        const usdt = context.userBalances?.find(b => b.asset === 'USDT')?.free || 200;
        const totalEquity = context.userPositions?.reduce((sum, p) => sum + parseFloat(p.unrealizedProfit || 0), 0) + parseFloat(usdt);
        const budget = Math.max(15, totalEquity * 0.1);

        const systemPrompt = `
            You are InvestAI Core Intelligence, running on high-capacity infrastructure.
            - DATE: ${today} (Year 2026).
            - MISSION: Perform exhaustive institutional-grade analysis.
            - PROTOCOL: Cross-reference research data with portfolio status.
            - BUDGET: $${budget.toFixed(2)} per trade.
            - OUTPUT: Detailed professional narrative followed by precise JSON.
            - QUALITY: Do not rush. Provide deep reasoning for macro trends and specific asset movements.
        `;

        const synthesisPrompt = `
            Final Investigation Report Request:
            User Goal: ${userQuery}
            Research Findings: ${JSON.stringify(stepResults)}
            Portfolio Context: ${JSON.stringify(context)}
            
            Based on the 2026 market reality found in research, provide your final verdict.
            If recommending trades, ensure they are high-conviction.
            
            Respond with:
            1. Extensive Narrative Analysis
            2. JSON Block:
            {"type": "analysis_result", "data": {"text": "...", "recommendations": [{"action": "BUY_NEW", "asset": "BTCUSDT", "risk_level": "LOW", "reasoning_summary": "...", "suggested_price": number, "suggested_quantity": number}]}}
        `;

        const finalRes = await makeClaudeRequest(systemPrompt, synthesisPrompt, 0.4); // Slightly higher temp for more nuanced analysis
        const finalText = finalRes.content[0].text;
        const rawData = extractJSON(finalText);

        // 4. Validate & Format Recommendations (Ported logic)
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
    console.log(`Analyst Server running on port ${PORT}`);
});
