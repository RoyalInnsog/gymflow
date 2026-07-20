const express = require('express');
const router = express.Router();
const { checkSubscription } = require('../lib/apiUtils');

router.use(checkSubscription);

router.use('', require('./api/members'));
router.use('', require('./api/billing'));
router.use('', require('./api/marketing'));
router.use('', require('./api/settings'));
router.use('', require('./api/analytics'));
router.use('', require('./api/core'));
router.use('/ai', require('./api/ai'));

module.exports = router;
