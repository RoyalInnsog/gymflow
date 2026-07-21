const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');

// Fallback to localhost if no Redis URL is provided. 
// Note: This WILL crash if Redis is not running locally.
const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null // Required by BullMQ
});

connection.on('error', (err) => {
    console.error('[RedisQueue] Redis Connection Error:', err.message);
});

// WhatsApp Queue
const whatsappQueue = new Queue('whatsapp_messages', { connection });

// Generic Queue for other background jobs
const genericQueue = new Queue('generic_jobs', { connection });

module.exports = {
    connection,
    whatsappQueue,
    genericQueue,
    Worker // Exporting Worker so other files can define job processing logic
};
