'use strict';

/**
 * BypassSecurityManager - The Wall Against Bot Abuse
 * 
 * Manages Discord bypass security, rate limiting, and abuse detection.
 * Because letting everyone bypass captcha freely is how you get bot armies.
 * 
 * Features:
 * - IP-based rate limiting (20 attempts per IP)
 * - Discord User ID-based rate limiting (50 attempts per User ID)
 * - VPN/Proxy detection (max 2 different IPs per User ID)
 * - Discord ID verification (must provide valid Discord User ID)
 * - Automatic cleanup after 5 minutes
 * - Suspicious activity tracking
 */

var Logger = require('../modules/Logger');

function BypassSecurityManager(gameServer) {
    this.gameServer = gameServer;
    
    // Track bypass attempts per IP
    this.ipAttempts = new Map(); // IP -> { count: number, timestamp: number }
    
    // Track bypass attempts per Discord User ID
    this.userIdAttempts = new Map(); // UserID -> { count: number, timestamp: number, ips: Set<IP> }
    
    // Track IPs used by each Discord User ID (for VPN/proxy detection)
    this.userIdIPs = new Map(); // UserID -> Set<IP>
    
    // Track verified Discord User IDs (so we don't keep hitting the API)
    this.verifiedUserIds = new Map(); // UserID -> { discordName: string, verifiedAt: number }
    
    // Track suspicious Discord User IDs (too many bypass attempts)
    this.suspiciousUserIds = new Set(); // Set<UserID>
    
    // Track banned Discord User IDs (rate limit exceeded)
    this.bannedUserIds = new Map(); // UserID -> { bannedAt: number, reason: string }
    
    // Limits - tune these based on your server's needs
    this.IP_ATTEMPT_LIMIT = 20;           // Max bypass attempts per IP
    this.USER_ID_ATTEMPT_LIMIT = 50;      // Max bypass attempts per Discord User ID
    this.USER_ID_IP_LIMIT = 3;            // Max different IPs per User ID (prevents VPN abuse)
    this.CLEANUP_TIME = 5 * 60 * 1000;    // 5 minutes
    this.VERIFIED_TTL = 30 * 60 * 1000;   // 30 minutes for verified user cache
    this.BAN_DURATION = 60 * 60 * 1000;   // 1 hour ban for abuse
    
    // Start cleanup timer
    this.startCleanupTimer();
    
    Logger.info('[SECURITY] BypassSecurityManager initialized - Discord ID verification enabled');
}

// ==================== IP TRACKING ====================

/**
 * Get bypass attempt count for an IP
 */
BypassSecurityManager.prototype.getIPAttemptCount = function(ip) {
    var data = this.ipAttempts.get(ip);
    if (!data) return 0;
    
    // Check if expired (5 minutes)
    if (Date.now() - data.timestamp > this.CLEANUP_TIME) {
        this.ipAttempts.delete(ip);
        return 0;
    }
    
    return data.count;
};

/**
 * Increment bypass attempt count for an IP
 */
BypassSecurityManager.prototype.incrementIPAttempt = function(ip) {
    var data = this.ipAttempts.get(ip);
    
    if (!data) {
        this.ipAttempts.set(ip, { count: 1, timestamp: Date.now() });
    } else {
        // Check if expired (5 minutes)
        if (Date.now() - data.timestamp > this.CLEANUP_TIME) {
            // Reset count if expired
            this.ipAttempts.set(ip, { count: 1, timestamp: Date.now() });
        } else {
            data.count++;
            data.timestamp = Date.now(); // Update timestamp
        }
    }
};

/**
 * Check if IP is blocked (exceeded rate limit)
 */
BypassSecurityManager.prototype.isIPBlocked = function(ip) {
    return this.getIPAttemptCount(ip) >= this.IP_ATTEMPT_LIMIT;
};

// ==================== DISCORD USER ID TRACKING ====================

/**
 * Get bypass attempt count for a Discord User ID
 */
BypassSecurityManager.prototype.getUserIdAttemptCount = function(userId) {
    if (!userId) return 0;
    
    var data = this.userIdAttempts.get(userId);
    if (!data) return 0;
    
    // Check if expired (5 minutes)
    if (Date.now() - data.timestamp > this.CLEANUP_TIME) {
        this.userIdAttempts.delete(userId);
        return 0;
    }
    
    return data.count;
};

/**
 * Increment bypass attempt count for a Discord User ID
 */
BypassSecurityManager.prototype.incrementUserIdAttempt = function(userId, ip) {
    if (!userId) return;
    
    var data = this.userIdAttempts.get(userId);
    
    if (!data) {
        var ips = new Set();
        if (ip) ips.add(ip);
        this.userIdAttempts.set(userId, { count: 1, timestamp: Date.now(), ips: ips });
    } else {
        // Check if expired (5 minutes)
        if (Date.now() - data.timestamp > this.CLEANUP_TIME) {
            // Reset count if expired
            var freshIps = new Set();
            if (ip) freshIps.add(ip);
            this.userIdAttempts.set(userId, { count: 1, timestamp: Date.now(), ips: freshIps });
        } else {
            data.count++;
            data.timestamp = Date.now();
            if (ip) data.ips.add(ip);
            
            // Check if this user is becoming suspicious
            if (data.count >= this.USER_ID_ATTEMPT_LIMIT * 0.7) {
                this.suspiciousUserIds.add(userId);
                Logger.warn('[SECURITY] ⚠️ Discord User ID ' + userId + ' marked as suspicious (high bypass attempts)');
            }
        }
    }
};

/**
 * Check if User ID is blocked (exceeded rate limit)
 */
BypassSecurityManager.prototype.isUserIdBlocked = function(userId) {
    if (!userId) return false;
    
    // Check if banned
    if (this.bannedUserIds.has(userId)) {
        var banData = this.bannedUserIds.get(userId);
        if (Date.now() - banData.bannedAt < this.BAN_DURATION) {
            return true; // Still banned
        } else {
            this.bannedUserIds.delete(userId); // Ban expired
        }
    }
    
    return this.getUserIdAttemptCount(userId) >= this.USER_ID_ATTEMPT_LIMIT;
};

// ==================== VPN/PROXY DETECTION ====================

/**
 * Track IP used by a Discord User ID
 */
BypassSecurityManager.prototype.trackUserIdIP = function(userId, ip) {
    if (!userId || !ip) return;
    
    if (!this.userIdIPs.has(userId)) {
        this.userIdIPs.set(userId, new Set());
    }
    
    this.userIdIPs.get(userId).add(ip);
};

/**
 * Get number of different IPs used by a Discord User ID
 */
BypassSecurityManager.prototype.getUserIdIPCount = function(userId) {
    if (!userId) return 0;
    
    var ips = this.userIdIPs.get(userId);
    return ips ? ips.size : 0;
};

/**
 * Check if User ID is using too many different IPs (VPN/proxy bot abuse)
 */
BypassSecurityManager.prototype.isUserIdUsingTooManyIPs = function(userId) {
    if (!userId) return false;
    return this.getUserIdIPCount(userId) > this.USER_ID_IP_LIMIT;
};

// ==================== DISCORD ID VERIFICATION ====================

/**
 * Check if Discord User ID is in verified cache
 */
BypassSecurityManager.prototype.isUserIdVerified = function(userId) {
    if (!userId) return false;
    
    var data = this.verifiedUserIds.get(userId);
    if (!data) return false;
    
    // Check if verification expired
    if (Date.now() - data.verifiedAt > this.VERIFIED_TTL) {
        this.verifiedUserIds.delete(userId);
        return false;
    }
    
    return true;
};

/**
 * Cache verified Discord User ID
 */
BypassSecurityManager.prototype.cacheVerifiedUserId = function(userId, discordName) {
    if (!userId) return;
    
    this.verifiedUserIds.set(userId, {
        discordName: discordName || 'Unknown',
        verifiedAt: Date.now()
    });
    
    Logger.debug('[SECURITY] ✅ Cached verified Discord User ID: ' + userId + ' (' + (discordName || 'Unknown') + ')');
};

/**
 * Ban a Discord User ID for abuse
 */
BypassSecurityManager.prototype.banUserId = function(userId, reason) {
    if (!userId) return;
    
    this.bannedUserIds.set(userId, {
        bannedAt: Date.now(),
        reason: reason || 'Rate limit exceeded'
    });
    
    Logger.warn('[SECURITY] 🚫 Discord User ID ' + userId + ' BANNED for: ' + reason);
};

// ==================== MAIN VALIDATION LOGIC ====================

/**
 * Validate bypass attempt with Discord ID verification
 * Returns { allowed: boolean, reason: string, details: object }
 * 
 * This is the main function - it checks everything:
 * 1. IP rate limit
 * 2. Discord User ID rate limit
 * 3. VPN/Proxy detection
 * 4. Discord ID must be provided
 */
BypassSecurityManager.prototype.validateBypassAttempt = function(ip, userId, discordToken) {
    var result = {
        allowed: true,
        reason: null,
        details: {},
        requiresDiscordId: false
    };
    
    // SECURITY: Discord bypass requires Discord User ID
    // This is the key improvement - no Discord ID = no bypass
    if (!userId) {
        result.allowed = false;
        result.reason = 'MISSING_DISCORD_ID';
        result.requiresDiscordId = true;
        result.details.message = 'Discord bypass requires valid Discord User ID';
        Logger.info('[SECURITY] ❌ Bypass rejected - No Discord User ID provided from IP: ' + ip);
        return result;
    }
    
    // Check if Discord User ID is banned
    if (this.bannedUserIds.has(userId)) {
        var banData = this.bannedUserIds.get(userId);
        if (Date.now() - banData.bannedAt < this.BAN_DURATION) {
            result.allowed = false;
            result.reason = 'USER_ID_BANNED';
            result.details.banReason = banData.reason;
            result.details.banRemaining = Math.floor((this.BAN_DURATION - (Date.now() - banData.bannedAt)) / 60000) + ' minutes';
            Logger.info('[SECURITY] ❌ Bypass rejected - Discord User ID ' + userId + ' is BANNED');
            return result;
        } else {
            // Ban expired
            this.bannedUserIds.delete(userId);
        }
    }
    
    // Check IP rate limit
    var ipCount = this.getIPAttemptCount(ip);
    result.details.ipAttemptCount = ipCount;
    
    if (this.isIPBlocked(ip)) {
        result.allowed = false;
        result.reason = 'IP_RATE_LIMIT';
        result.details.ipLimit = this.IP_ATTEMPT_LIMIT;
        Logger.info('[SECURITY] ❌ Bypass rejected - IP rate limit exceeded for: ' + ip);
        return result;
    }
    
    // Check User ID rate limit
    var userIdCount = this.getUserIdAttemptCount(userId);
    var userIdIPCount = this.getUserIdIPCount(userId);
    
    result.details.userIdAttemptCount = userIdCount;
    result.details.userIdIPCount = userIdIPCount;
    result.details.isSuspicious = this.suspiciousUserIds.has(userId);
    
    // Check VPN/Proxy abuse (too many different IPs for one account)
    if (this.isUserIdUsingTooManyIPs(userId)) {
        result.allowed = false;
        result.reason = 'USER_ID_TOO_MANY_IPS';
        result.details.userIdIPLimit = this.USER_ID_IP_LIMIT;
        result.details.currentIPCount = userIdIPCount;
        Logger.warn('[SECURITY] ❌ Bypass rejected - Discord User ID ' + userId + ' using too many IPs (' + userIdIPCount + ')');
        
        // Ban this user for VPN abuse
        this.banUserId(userId, 'VPN/Proxy abuse detected');
        return result;
    }
    
    // Check User ID rate limit
    if (this.isUserIdBlocked(userId)) {
        result.allowed = false;
        result.reason = 'USER_ID_RATE_LIMIT';
        result.details.userIdLimit = this.USER_ID_ATTEMPT_LIMIT;
        Logger.info('[SECURITY] ❌ Bypass rejected - Discord User ID ' + userId + ' rate limit exceeded');
        
        // Ban this user for rate limit abuse
        this.banUserId(userId, 'Rate limit exceeded');
        return result;
    }
    
    // All checks passed
    Logger.debug('[SECURITY] ✅ Bypass attempt allowed for Discord User ID: ' + userId + ' from IP: ' + ip);
    return result;
};

/**
 * Record successful bypass attempt
 */
BypassSecurityManager.prototype.recordBypassAttempt = function(ip, userId) {
    this.incrementIPAttempt(ip);
    
    if (userId) {
        this.trackUserIdIP(userId, ip);
        this.incrementUserIdAttempt(userId, ip);
    }
};

/**
 * Record successful bypass (after Discord token validation)
 */
BypassSecurityManager.prototype.recordSuccessfulBypass = function(ip, userId, discordName) {
    if (userId) {
        this.cacheVerifiedUserId(userId, discordName);
    }
    Logger.info('[SECURITY] ✅ Discord bypass successful for User ID: ' + userId + ' from IP: ' + ip);
};

// ==================== CLEANUP ====================

/**
 * Clean up expired entries (older than 5 minutes)
 */
BypassSecurityManager.prototype.cleanup = function() {
    var now = Date.now();
    var cleaned = 0;
    
    // Clean IP attempts
    var ipKeysToDelete = [];
    this.ipAttempts.forEach(function(data, key) {
        if (now - data.timestamp > this.CLEANUP_TIME) {
            ipKeysToDelete.push(key);
        }
    }, this);
    
    ipKeysToDelete.forEach(function(key) {
        this.ipAttempts.delete(key);
        cleaned++;
    }, this);
    
    // Clean User ID attempts
    var userIdKeysToDelete = [];
    this.userIdAttempts.forEach(function(data, key) {
        if (now - data.timestamp > this.CLEANUP_TIME) {
            userIdKeysToDelete.push(key);
        }
    }, this);
    
    userIdKeysToDelete.forEach(function(key) {
        this.userIdAttempts.delete(key);
        this.userIdIPs.delete(key);
        cleaned++;
    }, this);
    
    // Clean verified user cache
    var verifiedKeysToDelete = [];
    this.verifiedUserIds.forEach(function(data, key) {
        if (now - data.verifiedAt > this.VERIFIED_TTL) {
            verifiedKeysToDelete.push(key);
        }
    }, this);
    
    verifiedKeysToDelete.forEach(function(key) {
        this.verifiedUserIds.delete(key);
        cleaned++;
    }, this);
    
    // Clean expired bans
    var banKeysToDelete = [];
    this.bannedUserIds.forEach(function(data, key) {
        if (now - data.bannedAt > this.BAN_DURATION) {
            banKeysToDelete.push(key);
        }
    }, this);
    
    banKeysToDelete.forEach(function(key) {
        this.bannedUserIds.delete(key);
        cleaned++;
    }, this);
    
    // Clear suspicious list periodically
    if (this.suspiciousUserIds.size > 100) {
        this.suspiciousUserIds.clear();
    }
    
    if (cleaned > 0) {
        Logger.debug('[SECURITY] Cleaned up ' + cleaned + ' expired bypass entries');
    }
};

/**
 * Start automatic cleanup timer (runs every minute)
 */
BypassSecurityManager.prototype.startCleanupTimer = function() {
    var self = this;
    
    // Run cleanup every minute
    this.cleanupTimer = setInterval(function() {
        self.cleanup();
    }, 60 * 1000); // 1 minute
    
    Logger.debug('[SECURITY] Cleanup timer started (runs every 1 minute, expires after 5 minutes)');
};

/**
 * Stop cleanup timer
 */
BypassSecurityManager.prototype.stopCleanupTimer = function() {
    if (this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
        Logger.info('[SECURITY] Cleanup timer stopped');
    }
};

/**
 * Get security statistics
 */
BypassSecurityManager.prototype.getStats = function() {
    return {
        ipAttempts: this.ipAttempts.size,
        userIdAttempts: this.userIdAttempts.size,
        trackedUserIds: this.userIdIPs.size,
        verifiedUserIds: this.verifiedUserIds.size,
        suspiciousUserIds: this.suspiciousUserIds.size,
        bannedUserIds: this.bannedUserIds.size,
        limits: {
            ipLimit: this.IP_ATTEMPT_LIMIT,
            userIdLimit: this.USER_ID_ATTEMPT_LIMIT,
            userIdIPLimit: this.USER_ID_IP_LIMIT
        },
        cleanupTime: this.CLEANUP_TIME / 1000 / 60 + ' minutes',
        banDuration: this.BAN_DURATION / 1000 / 60 + ' minutes'
    };
};

module.exports = BypassSecurityManager;

