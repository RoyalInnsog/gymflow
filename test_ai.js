const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/ai/ask',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'test_admin_key' // Just to bypass auth if possible, or I'll just check if it returns 401
  }
};

const req = http.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    console.log(`BODY: ${chunk}`);
  });
});

req.write(JSON.stringify({ message: "What should I do?" }));
req.end();
