// Vercel Serverless Function for World Ranking
// Uses Upstash Redis

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!UPSTASH_URL || !UPSTASH_TOKEN) {
        return res.status(500).json({ error: 'Server configuration error' });
    }

    // Helper function to call Upstash REST API
    async function upstashCommand(command) {
        const response = await fetch(`${UPSTASH_URL}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${UPSTASH_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(command)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Upstash API error:', response.status, errorText);
            throw new Error(`Upstash API error: ${response.status} ${errorText}`);
        }
        
        const data = await response.json();
        return data;
    }

    try {
        // GET: ランキング取得
        if (req.method === 'GET') {
            const mode = req.query.mode || 'flick';
            const key = `ranking:${mode}`;
            
            // Get top 50 scores (sorted set, highest first)
            const result = await upstashCommand(['ZREVRANGE', key, '0', '49', 'WITHSCORES']);
            
            if (!result.result || result.result.length === 0) {
                return res.status(200).json({ rankings: [] });
            }

            // Parse results: [name1, score1, name2, score2, ...]
            const rankings = [];
            for (let i = 0; i < result.result.length; i += 2) {
                const dataStr = result.result[i];
                const efficiency = parseInt(result.result[i + 1]);
                
                try {
                    const data = JSON.parse(dataStr);
                    rankings.push({
                        name: data.name,
                        score: data.score,
                        accuracy: data.accuracy,
                        efficiency: efficiency,
                        date: data.date
                    });
                } catch (e) {
                    // Legacy data format
                    rankings.push({
                        name: dataStr,
                        efficiency: efficiency
                    });
                }
            }

            return res.status(200).json({ rankings });
        }

        // POST: スコア保存
        if (req.method === 'POST') {
            const { mode, name, score, accuracy, efficiency } = req.body;

            if (!mode || !name || score === undefined || !accuracy || efficiency === undefined) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            const key = `ranking:${mode}`;
            const playerKey = `player:${mode}:${name}`;
            
            // Check if player already has a score
            const existingScore = await upstashCommand(['GET', playerKey]);
            
            if (existingScore.result) {
                const existing = JSON.parse(existingScore.result);
                // Only update if new score is higher
                if (efficiency <= existing.efficiency) {
                    return res.status(200).json({ 
                        success: true, 
                        message: 'Score not updated (existing score is higher)',
                        updated: false
                    });
                }
                // Remove old score from sorted set
                await upstashCommand(['ZREM', key, JSON.stringify(existing)]);
            }

            // Create score data
            const scoreData = {
                name: name,
                score: score,
                accuracy: accuracy,
                efficiency: efficiency,
                date: new Date().toLocaleDateString('ja-JP')
            };

            // Add to sorted set (score = efficiency for sorting)
            await upstashCommand(['ZADD', key, efficiency, JSON.stringify(scoreData)]);
            
            // Save player's best score
            await upstashCommand(['SET', playerKey, JSON.stringify(scoreData)]);

            // Trim to top 50
            await upstashCommand(['ZREMRANGEBYRANK', key, '0', '-51']);

            // Calculate rank
            const rank = await upstashCommand(['ZREVRANK', key, JSON.stringify(scoreData)]);
            const playerRank = rank.result !== null ? rank.result + 1 : 51;

            return res.status(200).json({ 
                success: true, 
                rank: playerRank,
                updated: true
            });
        }

        return res.status(405).json({ error: 'Method not allowed' });

    } catch (error) {
        console.error('API Error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

