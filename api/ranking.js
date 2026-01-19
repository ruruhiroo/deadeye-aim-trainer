// Vercel Serverless Function for World Ranking
// Uses Upstash Redis

export default async function handler(req, res) {
    // URLを複数の方法でチェック（VercelのServerless Functionsでは req.query が正しく動作しない場合がある）
    const urlString = req.url || req.originalUrl || '';
    const isTestMode = urlString.includes('test=true') || urlString.includes('?test=true') || 
                       req.query?.test === 'true' || req.query?.test === true;
    
    // URLからクエリパラメータをパース（mode取得用）
    let queryParams = {};
    try {
        if (urlString.includes('?')) {
            const url = new URL(urlString, `http://${req.headers.host || 'localhost'}`);
            queryParams = Object.fromEntries(url.searchParams);
        } else {
            queryParams = req.query || {};
        }
    } catch (e) {
        // URLパースに失敗した場合は req.query を使用
        queryParams = req.query || {};
    }
    
    // デバッグ用：全てのURL関連の情報をログに出力
    console.log('API called - Full request info:', {
        method: req.method,
        url: req.url,
        originalUrl: req.originalUrl,
        urlString: urlString,
        query: req.query,
        parsedQuery: queryParams,
        isTestMode: isTestMode,
        headers: {
            host: req.headers.host,
            referer: req.headers.referer
        }
    });
    
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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
            console.log('GET request:', {
                query: req.query,
                parsedQuery: queryParams,
                url: req.url,
                isTestMode: isTestMode
            });
            
            if (isTestMode) {
                try {
                    // Test 1: PING
                    const pingResult = await upstashCommand(['PING']);
                    console.log('PING test:', pingResult);
                    
                    // Test 2: Check if ranking key exists
                    const existsResult = await upstashCommand(['EXISTS', 'ranking:flick']);
                    console.log('EXISTS test:', existsResult);
                    
                    // Test 3: Try ZREVRANGE
                    const zrevrangeResult = await upstashCommand(['ZREVRANGE', 'ranking:flick', '0', '4', 'WITHSCORES']);
                    console.log('ZREVRANGE test:', zrevrangeResult);
                    
                    return res.status(200).json({
                        test: true,
                        env: {
                            url: UPSTASH_URL ? 'Set' : 'Not set',
                            token: UPSTASH_TOKEN ? 'Set' : 'Not set',
                            urlPreview: UPSTASH_URL ? UPSTASH_URL.substring(0, 30) + '...' : 'Not set'
                        },
                        tests: {
                            ping: pingResult,
                            exists: existsResult,
                            zrevrange: zrevrangeResult
                        }
                    });
                } catch (testError) {
                    console.error('Test error:', testError);
                    return res.status(500).json({
                        test: true,
                        error: testError.message,
                        stack: testError.stack
                    });
                }
            }
            
            const mode = queryParams.mode || req.query?.mode || 'flick';
            const key = `ranking:${mode}`;
            
            console.log('Fetching rankings for mode:', mode, 'key:', key);
            
            // Get top 50 scores (sorted set, highest first)
            const result = await upstashCommand(['ZREVRANGE', key, '0', '49', 'WITHSCORES']);
            
            console.log('Upstash result (raw):', JSON.stringify(result, null, 2));
            console.log('Upstash result type:', typeof result);
            if (result && typeof result === 'object') {
                console.log('Upstash result keys:', Object.keys(result));
                // 全てのプロパティを確認
                for (const [key, value] of Object.entries(result)) {
                    console.log(`  ${key}:`, typeof value, Array.isArray(value) ? `array[${value?.length || 0}]` : value);
                }
            }
            
            // Upstashのレスポンス形式を確認
            // Upstash REST APIは { result: [...] } の形式で返す
            let scores = [];
            if (result) {
                // まず、result.result を確認（Upstash REST APIの標準形式）
                if (result.result !== undefined) {
                    console.log('Found result.result:', typeof result.result, Array.isArray(result.result));
                    if (Array.isArray(result.result)) {
                        scores = result.result;
                        console.log('Using result.result as scores array, length:', scores.length);
                    } else if (typeof result.result === 'string') {
                        // 文字列の場合は配列に変換を試みる
                        try {
                            const parsed = JSON.parse(result.result);
                            if (Array.isArray(parsed)) {
                                scores = parsed;
                                console.log('Parsed result.result string to array, length:', scores.length);
                            } else {
                                console.log('Parsed result is not an array:', typeof parsed, parsed);
                            }
                        } catch (e) {
                            console.error('Failed to parse result.result as JSON:', e);
                        }
                    } else {
                        console.log('result.result is not an array or string:', typeof result.result, result.result);
                    }
                }
                // result 自体が配列の場合（直接配列が返される場合）
                else if (Array.isArray(result)) {
                    scores = result;
                    console.log('Using result directly as scores array, length:', scores.length);
                }
                // result がオブジェクトで、他のプロパティに配列がある場合
                else if (typeof result === 'object') {
                    console.log('Result is object, checking all properties for arrays...');
                    for (const [key, value] of Object.entries(result)) {
                        if (Array.isArray(value)) {
                            console.log(`Found array in property "${key}":`, value.length, 'items');
                            scores = value;
                            console.log(`Using ${key} as scores array, length:`, scores.length);
                            break;
                        }
                    }
                    // 配列が見つからない場合、すべての値を確認
                    if (scores.length === 0) {
                        console.log('No array found in result object. All values:', Object.values(result));
                        console.log('Full result object:', JSON.stringify(result, null, 2));
                    }
                }
            } else {
                console.error('Result is null or undefined!');
            }
            
            // デバッグ：scoresが空の場合、キーの存在と内容を確認
            if (scores.length === 0) {
                console.log('Scores array is empty. Checking key existence and content...');
                const existsResult = await upstashCommand(['EXISTS', key]);
                console.log('Key exists result:', existsResult);
                const existsValue = existsResult.result !== undefined ? existsResult.result : existsResult;
                console.log('Key exists value:', existsValue);
                
                if (existsValue === 1 || existsValue === true) {
                    // キーは存在するが、データが空の場合
                    console.log('Key exists but no data found. Trying ZCARD...');
                    const cardResult = await upstashCommand(['ZCARD', key]);
                    const cardValue = cardResult.result !== undefined ? cardResult.result : cardResult;
                    console.log('ZCARD result:', cardValue);
                    
                    // 別の方法で取得を試みる
                    console.log('Trying ZRANGE (ascending) as alternative...');
                    const altResult = await upstashCommand(['ZRANGE', key, '0', '-1', 'WITHSCORES']);
                    console.log('ZRANGE result:', JSON.stringify(altResult, null, 2));
                    
                    // もしZRANGEでデータが見つかった場合
                    if (altResult && altResult.result && Array.isArray(altResult.result) && altResult.result.length > 0) {
                        scores = altResult.result;
                        console.log('Found data using ZRANGE, length:', scores.length);
                    }
                }
            }
            
            console.log('Final parsed scores:', {
                count: scores.length,
                type: Array.isArray(scores) ? 'array' : typeof scores,
                firstFew: scores.slice(0, 5)
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
            console.log('Parsing scores array, length:', scores.length);
            
            for (let i = 0; i < scores.length; i += 2) {
                if (i + 1 >= scores.length) {
                    console.warn('Odd number of elements in scores array, skipping last element');
                    break;
                }
                
                const dataStr = scores[i];
                const efficiencyStr = scores[i + 1];
                const efficiency = parseInt(efficiencyStr);
                
                console.log(`Processing entry ${i/2 + 1}:`, {
                    dataStr: dataStr,
                    efficiencyStr: efficiencyStr,
                    efficiency: efficiency
                });
                
                try {
                    const data = JSON.parse(dataStr);
                    rankings.push({
                        name: data.name,
                        score: data.score,
                        accuracy: data.accuracy,
                        efficiency: efficiency,
                        date: data.date
                    });
                    console.log(`  Parsed successfully:`, data.name, efficiency);
                } catch (e) {
                    console.warn(`  Failed to parse dataStr as JSON:`, e.message);
                    // Legacy data format
                    rankings.push({
                        name: dataStr,
                        efficiency: efficiency
                    });
                    console.log(`  Using legacy format:`, dataStr, efficiency);
                }
            }
            
            console.log('Final rankings array:', {
                count: rankings.length,
                firstFew: rankings.slice(0, 3)
            });

            return res.status(200).json({ rankings });
        }

        // POST: スコア保存
        if (req.method === 'POST') {
            console.log('POST request received:', req.body);
            let { mode, name, score, accuracy, efficiency } = req.body;
            
            // accuracyが文字列（"%を含む）の場合は数値に変換
            if (typeof accuracy === 'string') {
                accuracy = parseFloat(accuracy.replace('%', ''));
                console.log('Converted accuracy from string to number:', accuracy);
            }
            
            // 型チェックと値の確認
            console.log('Validating fields:', {
                mode: typeof mode, name: typeof name, 
                score: typeof score, scoreValue: score,
                accuracy: typeof accuracy, accuracyValue: accuracy,
                efficiency: typeof efficiency, efficiencyValue: efficiency
            });

            if (!mode || !name || score === undefined || accuracy === undefined || accuracy === null || efficiency === undefined) {
                console.error('Missing required fields:', { mode, name, score, accuracy, efficiency });
                return res.status(400).json({ error: 'Missing required fields', details: { mode, name, score, accuracy, efficiency } });
            }
            
            // 数値の検証
            score = parseInt(score);
            accuracy = parseFloat(accuracy);
            efficiency = parseInt(efficiency);
            
            if (isNaN(score) || isNaN(accuracy) || isNaN(efficiency)) {
                console.error('Invalid numeric values:', { score, accuracy, efficiency });
                return res.status(400).json({ error: 'Invalid numeric values', details: { score, accuracy, efficiency } });
            }

            const key = `ranking:${mode}`;
            const playerKey = `player:${mode}:${name}`;
            
            console.log('Saving score:', { key, playerKey, efficiency });
            
            // Check if player already has a score
            const existingScore = await upstashCommand(['GET', playerKey]);
            console.log('Existing score check:', existingScore);
            
            const existingValue = existingScore.result !== undefined ? existingScore.result : existingScore;
            if (existingValue && existingValue !== null) {
                console.log('Existing score found:', existingValue, 'type:', typeof existingValue);
                
                // existingValueが文字列の場合はJSON.parse、既にオブジェクトの場合はそのまま使用
                let existing;
                if (typeof existingValue === 'string') {
                    try {
                        existing = JSON.parse(existingValue);
                    } catch (e) {
                        console.error('Failed to parse existing score:', e);
                        // パースに失敗した場合は新規として扱う
                        existing = null;
                    }
                } else if (typeof existingValue === 'object') {
                    existing = existingValue;
                } else {
                    console.warn('Unexpected existingValue type:', typeof existingValue);
                    existing = null;
                }
                
                if (existing && existing.efficiency !== undefined) {
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
                } else {
                    console.log('Existing score data is invalid or missing efficiency, proceeding with new score');
                }
            } else {
                console.log('No existing score found, proceeding with new score');
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
            const scoreDataStr = JSON.stringify(scoreData);
            console.log('Score data string:', scoreDataStr);
            console.log('ZADD command:', ['ZADD', key, efficiency.toString(), scoreDataStr]);
            
            try {
                const addResult = await upstashCommand(['ZADD', key, efficiency.toString(), scoreDataStr]);
                console.log('ZADD result (raw):', JSON.stringify(addResult, null, 2));
                console.log('ZADD result type:', typeof addResult);
                if (addResult && typeof addResult === 'object') {
                    console.log('ZADD result keys:', Object.keys(addResult));
                }
                
                // ZADDの成功を確認
                // ZADDは追加された要素の数を返す（既存の要素を更新した場合は0を返す可能性がある）
                let addSuccess;
                if (addResult.result !== undefined) {
                    addSuccess = addResult.result;
                } else if (typeof addResult === 'number') {
                    addSuccess = addResult;
                } else if (Array.isArray(addResult) && addResult.length > 0) {
                    addSuccess = addResult[0];
                } else {
                    addSuccess = addResult;
                }
                
                console.log('ZADD success value:', addSuccess, 'type:', typeof addSuccess);
                
                // ZADDが成功したか確認（0以上であれば成功）
                if (addSuccess === null || addSuccess === undefined) {
                    console.error('❌ ZADD may have failed - result is null/undefined');
                    throw new Error('ZADD command returned null/undefined');
                } else if (typeof addSuccess === 'number' && addSuccess < 0) {
                    console.error('❌ ZADD may have failed - result is negative:', addSuccess);
                    throw new Error(`ZADD command returned negative value: ${addSuccess}`);
                } else {
                    console.log('✅ ZADD successful, result value:', addSuccess);
                }
            } catch (addError) {
                console.error('❌ ZADD command failed:', addError);
                throw new Error(`Failed to add score to sorted set: ${addError.message}`);
            }
            
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
            console.log('Verifying saved score...');
            
            // まず、ZCARDで件数を確認
            const cardResult = await upstashCommand(['ZCARD', key]);
            const cardCount = cardResult.result !== undefined ? cardResult.result : cardResult;
            console.log('Total scores in sorted set (ZCARD):', cardCount, 'type:', typeof cardCount);
            
            // 次に、ZREVRANGEで全件取得（最大10件）
            const verifyResult = await upstashCommand(['ZREVRANGE', key, '0', '9', 'WITHSCORES']);
            console.log('Verification - top 10 scores after save (raw):', JSON.stringify(verifyResult, null, 2));
            
            // 保存したスコアが含まれているか確認
            let verifyScores = [];
            
            // Upstash REST APIのレスポンス形式を処理
            if (verifyResult) {
                if (verifyResult.result !== undefined) {
                    if (Array.isArray(verifyResult.result)) {
                        verifyScores = verifyResult.result;
                    } else if (typeof verifyResult.result === 'string') {
                        try {
                            const parsed = JSON.parse(verifyResult.result);
                            if (Array.isArray(parsed)) {
                                verifyScores = parsed;
                            }
                        } catch (e) {
                            console.error('Failed to parse verifyResult.result:', e);
                        }
                    }
                } else if (Array.isArray(verifyResult)) {
                    verifyScores = verifyResult;
                } else if (typeof verifyResult === 'object') {
                    // オブジェクト内の配列を探す
                    for (const [k, v] of Object.entries(verifyResult)) {
                        if (Array.isArray(v)) {
                            verifyScores = v;
                            break;
                        }
                    }
                }
            }
            
            console.log('Verification scores array length:', verifyScores.length);
            console.log('Verification scores array (first 10 items):', verifyScores.slice(0, 10));
            
            if (Array.isArray(verifyScores) && verifyScores.length > 0) {
                const found = verifyScores.some((item, index) => {
                    if (index % 2 === 0) {
                        try {
                            const data = JSON.parse(item);
                            const matches = data.name === name && parseInt(data.efficiency) === parseInt(efficiency);
                            if (matches) {
                                console.log('✅ Found matching score at index', index, ':', data);
                            }
                            return matches;
                        } catch (e) {
                            console.log('Failed to parse verification item:', item, e.message);
                            return false;
                        }
                    }
                    return false;
                });
                console.log('Saved score found in verification:', found);
                
                if (!found) {
                    console.warn('⚠️ WARNING: Saved score not found in verification results!');
                    console.warn('Expected name:', name, 'efficiency:', efficiency);
                    console.warn('Saved scoreData:', scoreData);
                    console.warn('Verification items (first 5):', verifyScores.slice(0, 10).map((item, i) => {
                        if (i % 2 === 0) {
                            try {
                                return JSON.parse(item);
                            } catch (e) {
                                return item;
                            }
                        }
                        return null;
                    }).filter(x => x !== null));
                    
                    // 別の方法で検証：ZSCOREで直接確認
                    console.log('Trying ZSCORE to verify...');
                    const zscoreResult = await upstashCommand(['ZSCORE', key, scoreDataStr]);
                    console.log('ZSCORE result:', zscoreResult);
                } else {
                    console.log('✅ Verification successful: Score is in the sorted set');
                }
            } else {
                console.warn('⚠️ WARNING: Verification result is not a valid array!');
                console.warn('verifyResult:', JSON.stringify(verifyResult, null, 2));
            }
            
            return res.status(200).json({ 
                success: true, 
                rank: playerRank,
                updated: true
            });
        }

        // DELETE: スコア削除（管理者用）
        if (req.method === 'DELETE') {
            const adminPassword = process.env.ADMIN_PASSWORD || 'hiro0419';
            const authHeader = req.headers.authorization;
            
            if (!authHeader || authHeader !== `Bearer ${adminPassword}`) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const { mode, name, efficiency, resetAll } = req.body;

            // ALLリセットの場合
            if (resetAll === true) {
                const modes = ['flick', 'tracking', 'grid'];
                const deletedKeys = [];

                for (const m of modes) {
                    const key = `ranking:${m}`;
                    // キーが存在するか確認
                    const exists = await upstashCommand(['EXISTS', key]);
                    const existsValue = exists.result !== undefined ? exists.result : exists;
                    
                    if (existsValue === 1 || existsValue === true) {
                        // キーを削除
                        await upstashCommand(['DEL', key]);
                        deletedKeys.push(key);
                    }

                    // プレイヤーのベストスコアも削除（パターンマッチで削除）
                    // 注意: Upstash REST APIではKEYSコマンドが使えないため、
                    // 個別に削除する必要があるが、全てのキーを列挙できない
                    // そのため、ここではrankingキーのみ削除
                }

                return res.status(200).json({ 
                    success: true, 
                    message: 'All rankings reset',
                    deletedKeys: deletedKeys
                });
            }

            // 個別削除の場合
            if (!mode || !name || efficiency === undefined) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            const key = `ranking:${mode}`;
            const playerKey = `player:${mode}:${name}`;

            // スコアデータを構築して削除
            const scoreDataStr = JSON.stringify({
                name: name,
                efficiency: parseInt(efficiency)
            });

            // Sorted setから削除
            await upstashCommand(['ZREM', key, scoreDataStr]);
            
            // プレイヤーのベストスコアも削除
            await upstashCommand(['DEL', playerKey]);

            return res.status(200).json({ success: true, message: 'Score deleted' });
        }

        // PUT: スコア編集（管理者用）
        if (req.method === 'PUT') {
            const adminPassword = process.env.ADMIN_PASSWORD || 'hiro0419';
            const authHeader = req.headers.authorization;
            
            if (!authHeader || authHeader !== `Bearer ${adminPassword}`) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            let { mode, oldName, oldEfficiency, newName, newScore, newAccuracy, newEfficiency } = req.body;
            
            if (!mode || !oldName || oldEfficiency === undefined || !newName || newScore === undefined || newAccuracy === undefined || newEfficiency === undefined) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            const key = `ranking:${mode}`;
            const oldPlayerKey = `player:${mode}:${oldName}`;
            const newPlayerKey = `player:${mode}:${newName}`;

            // 古いスコアデータ
            const oldScoreDataStr = JSON.stringify({
                name: oldName,
                efficiency: parseInt(oldEfficiency)
            });

            // 新しいスコアデータ
            const newScoreData = {
                name: newName,
                score: parseInt(newScore),
                accuracy: parseFloat(newAccuracy),
                efficiency: parseInt(newEfficiency),
                date: new Date().toLocaleDateString('ja-JP')
            };
            const newScoreDataStr = JSON.stringify(newScoreData);

            // 古いスコアを削除
            await upstashCommand(['ZREM', key, oldScoreDataStr]);
            
            // 新しいスコアを追加
            await upstashCommand(['ZADD', key, newEfficiency.toString(), newScoreDataStr]);

            // プレイヤーのベストスコアを更新
            if (oldName !== newName) {
                await upstashCommand(['DEL', oldPlayerKey]);
            }
            await upstashCommand(['SET', newPlayerKey, newScoreDataStr]);

            // Top 50にトリム
            const currentCount = await upstashCommand(['ZCARD', key]);
            if (currentCount && (currentCount.result || currentCount) > 50) {
                await upstashCommand(['ZREMRANGEBYRANK', key, '50', '-1']);
            }

            return res.status(200).json({ success: true, message: 'Score updated' });
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

