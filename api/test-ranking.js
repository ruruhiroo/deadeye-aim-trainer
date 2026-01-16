// Test endpoint for Upstash connection
export default async function handler(req, res) {
    const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (!UPSTASH_URL || !UPSTASH_TOKEN) {
        return res.status(500).json({ 
            error: 'Environment variables not set',
            hasUrl: !!UPSTASH_URL,
            hasToken: !!UPSTASH_TOKEN
        });
    }

    try {
        // Test 1: Simple PING command
        const pingResponse = await fetch(UPSTASH_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${UPSTASH_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(['PING'])
        });

        const pingData = await pingResponse.json();
        console.log('PING result:', pingData);

        // Test 2: Try to SET a test value
        const setResponse = await fetch(UPSTASH_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${UPSTASH_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(['SET', 'test:key', 'test:value'])
        });

        const setData = await setResponse.json();
        console.log('SET result:', setData);

        // Test 3: Try to GET the test value
        const getResponse = await fetch(UPSTASH_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${UPSTASH_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(['GET', 'test:key'])
        });

        const getData = await getResponse.json();
        console.log('GET result:', getData);

        // Test 4: Check if ranking key exists
        const existsResponse = await fetch(UPSTASH_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${UPSTASH_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(['EXISTS', 'ranking:flick'])
        });

        const existsData = await existsResponse.json();
        console.log('EXISTS result:', existsData);

        // Test 5: Try ZREVRANGE
        const zrevrangeResponse = await fetch(UPSTASH_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${UPSTASH_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(['ZREVRANGE', 'ranking:flick', '0', '4', 'WITHSCORES'])
        });

        const zrevrangeData = await zrevrangeResponse.json();
        console.log('ZREVRANGE result:', zrevrangeData);

        return res.status(200).json({
            success: true,
            tests: {
                ping: {
                    status: pingResponse.status,
                    data: pingData
                },
                set: {
                    status: setResponse.status,
                    data: setData
                },
                get: {
                    status: getResponse.status,
                    data: getData
                },
                exists: {
                    status: existsResponse.status,
                    data: existsData
                },
                zrevrange: {
                    status: zrevrangeResponse.status,
                    data: zrevrangeData
                }
            },
            env: {
                url: UPSTASH_URL ? 'Set' : 'Not set',
                token: UPSTASH_TOKEN ? 'Set' : 'Not set'
            }
        });

    } catch (error) {
        console.error('Test error:', error);
        return res.status(500).json({
            error: error.message,
            stack: error.stack
        });
    }
}

