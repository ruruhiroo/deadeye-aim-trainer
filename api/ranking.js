// Vercel Serverless Function for World Ranking
// Uses Upstash Redis

export default async function handler(req, res) {
    console.log('API called:', {
        method: req.method,
        url: req.url,
        query: req.query
    });
    
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
        console.error('Missing environment variables:', {
            UPSTASH_URL: !!UPSTASH_URL,
            UPSTASH_TOKEN: !!UPSTASH_TOKEN
        });
        return res.status(500).json({ 
            error: 'Server configuration error',
            message: 'Upstash credentials not configured. Please check environment variables.'
        });
    }

    // Helper function to call Upstash REST API
    async function upstashCommand(command) {
        try {
            // Upstash REST API endpoint
            // 環境変数のURLをそのまま使用（Upstashの環境変数には完全なURLが含まれている）
            const apiUrl = UPSTASH_URL;
            
            console.log('Calling Upstash API:', {
                url: apiUrl,
                command: command
            });
            
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${UPSTASH_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(command)
            });
            
            const responseText = await response.text();
            console.log('Upstash API raw response:', {
                status: response.status,
                statusText: response.statusText,
                body: responseText.substring(0, 500) // 長すぎる場合は切り詰め
            });
            
            if (!response.ok) {
                console.error('Upstash API error:', {
                    status: response.status,
                    statusText: response.statusText,
                    error: responseText,
                    command: command,
                    url: apiUrl,
                    hasToken: !!UPSTASH_TOKEN
                });
                
                // より分かりやすいエラーメッセージ
                let errorMessage = `Upstash API error (${response.status})`;
                if (response.status === 401) {
                    errorMessage = 'Upstash認証エラー: トークンが無効です';
                } else if (response.status === 404) {
                    errorMessage = 'Upstash APIエンドポイントが見つかりません';
                } else if (response.status >= 500) {
                    errorMessage = 'Upstashサーバーエラー';
                }
                
                throw new Error(`${errorMessage}: ${responseText.substring(0, 200)}`);
            }
            
            let data;
            try {
                data = JSON.parse(responseText);
            } catch (e) {
                console.error('Failed to parse Upstash response as JSON:', responseText);
                throw new Error(`Invalid JSON response from Upstash: ${responseText}`);
            }
            
            console.log('Upstash API parsed response:', data);
            
            // Upstashのレスポンス形式を確認
            if (data.error) {
                console.error('Upstash returned error:', data.error);
                throw new Error(data.error);
            }
            
            return data;
        } catch (error) {
            console.error('Upstash command failed:', {
                error: error.message,
                stack: error.stack,
                command: command,
                url: UPSTASH_URL
            });
            throw error;
        }
    }

    try {
        // GET: ランキング取得
        if (req.method === 'GET') {
            const mode = req.query.mode || 'flick';
            const key = `ranking:${mode}`;
            
            console.log('Fetching rankings for mode:', mode, 'key:', key);
            
            // Get top 50 scores (sorted set, highest first)
            const result = await upstashCommand(['ZREVRANGE', key, '0', '49', 'WITHSCORES']);
            
            console.log('Upstash result:', JSON.stringify(result, null, 2));
            
            // Upstashのレスポンス形式を確認
            // Upstash REST APIは { result: [...] } の形式で返す
            let scores = [];
            if (result) {
                // result.result が配列の場合
                if (result.result !== undefined) {
                    if (Array.isArray(result.result)) {
                        scores = result.result;
                    } else {
                        // result.result が文字列やその他の場合
                        console.log('result.result is not an array:', typeof result.result, result.result);
                    }
                }
                // result 自体が配列の場合（直接配列が返される場合）
                else if (Array.isArray(result)) {
                    scores = result;
                }
            }
            
            console.log('Parsed scores:', {
                count: scores.length,
                type: Array.isArray(scores) ? 'array' : typeof scores,
                firstFew: scores.slice(0, 3)
            });
            
            if (!scores || scores.length === 0) {
                console.log('No rankings found for key:', key);
                // デバッグ用：キーが存在するか確認
                const exists = await upstashCommand(['EXISTS', key]);
                console.log('Key exists check:', exists);
                return res.status(200).json({ rankings: [] });
            }

            // Parse results: [name1, score1, name2, score2, ...]
            const rankings = [];
            for (let i = 0; i < scores.length; i += 2) {
                const dataStr = scores[i];
                const efficiency = parseInt(scores[i + 1]);
                
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
            console.log('POST request received:', req.body);
            const { mode, name, score, accuracy, efficiency } = req.body;

            if (!mode || !name || score === undefined || !accuracy || efficiency === undefined) {
                console.error('Missing required fields:', { mode, name, score, accuracy, efficiency });
                return res.status(400).json({ error: 'Missing required fields' });
            }

            const key = `ranking:${mode}`;
            const playerKey = `player:${mode}:${name}`;
            
            console.log('Saving score:', { key, playerKey, efficiency });
            
            // Check if player already has a score
            const existingScore = await upstashCommand(['GET', playerKey]);
            console.log('Existing score check:', existingScore);
            
            const existingValue = existingScore.result || existingScore;
            if (existingValue) {
                console.log('Existing score found:', existingValue);
                const existing = JSON.parse(existingValue);
                // Only update if new score is higher
                if (efficiency <= existing.efficiency) {
                    console.log('New score is not higher, skipping update');
                    return res.status(200).json({ 
                        success: true, 
                        message: 'Score not updated (existing score is higher)',
                        updated: false
                    });
                }
                console.log('Removing old score from sorted set');
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

            console.log('Adding score to sorted set:', scoreData);
            // Add to sorted set (score = efficiency for sorting)
            const addResult = await upstashCommand(['ZADD', key, efficiency, JSON.stringify(scoreData)]);
            console.log('ZADD result:', addResult);
            
            console.log('Saving player best score');
            // Save player's best score
            const setResult = await upstashCommand(['SET', playerKey, JSON.stringify(scoreData)]);
            console.log('SET result:', setResult);

            console.log('Trimming to top 50');
            // Trim to top 50 (keep top 50, remove the rest)
            // ZREMRANGEBYRANK removes by rank index (0-based, ascending order)
            // Since we use ZREVRANGE (descending), we need to remove from the end
            // To keep top 50, remove ranks 50 onwards (0-indexed, so 50-49 = keep 50 items)
            // ZREMRANGEBYRANK key 50 -1 removes from index 50 to the end
            const currentCount = await upstashCommand(['ZCARD', key]);
            console.log('Current count before trim:', currentCount);
            if (currentCount && (currentCount.result || currentCount) > 50) {
                const trimResult = await upstashCommand(['ZREMRANGEBYRANK', key, '50', '-1']);
                console.log('Trim result:', trimResult);
            } else {
                console.log('No need to trim, count is:', currentCount);
            }

            console.log('Calculating rank');
            // Calculate rank
            const rank = await upstashCommand(['ZREVRANK', key, JSON.stringify(scoreData)]);
            console.log('Rank result:', rank);
            const rankValue = rank.result !== undefined ? rank.result : rank;
            const playerRank = rankValue !== null && rankValue !== undefined ? rankValue + 1 : 51;

            console.log('Score saved successfully, rank:', playerRank);
            
            // デバッグ用：保存後にすぐ取得して確認
            const verifyResult = await upstashCommand(['ZREVRANGE', key, '0', '4', 'WITHSCORES']);
            console.log('Verification - top 5 scores after save:', verifyResult);
            
            return res.status(200).json({ 
                success: true, 
                rank: playerRank,
                updated: true
            });
        }

        return res.status(405).json({ error: 'Method not allowed' });

    } catch (error) {
        console.error('API Error:', {
            message: error.message,
            stack: error.stack,
            url: UPSTASH_URL ? 'Set' : 'Not set',
            token: UPSTASH_TOKEN ? 'Set' : 'Not set'
        });
        return res.status(500).json({ 
            error: 'Internal server error',
            message: error.message,
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
}

