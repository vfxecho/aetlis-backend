"use strict";

/**
 * HCaptchaService - Lightweight hCaptcha helper
 * 
 * This shit handles all the captcha verification magic:
 *  - Track single-use tokens with TTL enforcement (no token reuse bullshit)
 *  - Execute verification requests against hcaptcha.com
 *  - Enforce optional hostname allow list
 *  - Extra security layers because bots are annoying af
 * 
 * The class is intentionally dependency-free so it can be reused anywhere.
 */

const https = require("https");
const { URLSearchParams } = require("url");

class HCaptchaService {
    /**
     * @param {Object} [options]
     * @param {string} [options.secret] - hCaptcha secret key
     * @param {string[]} [options.allowedHostnames] - Restrict to these hostnames
     * @param {number} [options.tokenTtlMs] - Token time-to-live in ms
     * @param {Object} [options.logger] - Custom logger (defaults to console)
     */
    constructor(options = {}) {
        const {
            secret = "",
            allowedHostnames = [],
            tokenTtlMs = 10 * 60 * 1000, // 10 minutes default
            logger,
        } = options;

        this.secret = secret;
        this.allowedHostnames = Array.isArray(allowedHostnames) ? allowedHostnames : [];
        this.tokenTtlMs = tokenTtlMs > 0 ? tokenTtlMs : 10 * 60 * 1000;
        this.logger = logger || console;

        /**
         * Track used tokens to prevent replay attacks
         * @type {Map<string, {ip: string, ts: number}>}
         */
        this.usedTokens = new Map();
    }

    /**
     * Replace configuration at runtime (after config reload).
     * Hot reload support - because restarting is for losers
     * @param {{secret?: string, allowedHostnames?: string[], tokenTtlMs?: number}} cfg
     */
    configure(cfg = {}) {
        if (cfg.secret !== undefined) this.secret = cfg.secret;
        if (cfg.allowedHostnames !== undefined) {
            this.allowedHostnames = Array.isArray(cfg.allowedHostnames) ? cfg.allowedHostnames : [];
        }
        if (typeof cfg.tokenTtlMs === "number" && cfg.tokenTtlMs > 0) {
            this.tokenTtlMs = cfg.tokenTtlMs;
        }
    }

    /**
     * Allow dependency injection of a custom logger
     * @param {{info?:Function, warn?:Function, error?:Function}} logger
     */
    setLogger(logger) {
        if (logger) {
            this.logger = logger;
        }
    }

    /**
     * Returns true if the token is already known/active (prevent token reuse).
     * Expired entries are lazily removed.
     * @param {string} token
     * @param {string} [remoteIp]
     */
    isTokenUsed(token, remoteIp) {
        if (!token) return false;
        const entry = this.usedTokens.get(token);
        if (!entry) return false;

        // Check if token expired
        if (Date.now() - entry.ts > this.tokenTtlMs) {
            this.usedTokens.delete(token);
            return false;
        }

        // Log if someone's trying to reuse a token from different IP (sus af)
        if (remoteIp && entry.ip && entry.ip !== remoteIp) {
            this.logger && this.logger.warn && this.logger.warn(
                `[HCAPTCHA] ❌ IP mismatch for reused token | original=${entry.ip} | current=${remoteIp}`
            );
        }

        return true;
    }

    /**
     * Track the token as consumed.
     * @param {string} token
     * @param {string} [remoteIp]
     */
    markTokenUsed(token, remoteIp) {
        if (!token) return;
        this.usedTokens.set(token, {
            ip: remoteIp || "unknown",
            ts: Date.now(),
        });
    }

    /**
     * Remove stale entries to keep the map bounded.
     * Called periodically by the game server tick.
     */
    cleanupExpiredTokens() {
        const now = Date.now();
        for (const [token, meta] of this.usedTokens.entries()) {
            if (now - meta.ts > this.tokenTtlMs) {
                this.usedTokens.delete(token);
            }
        }
    }

    /**
     * Perform hCaptcha verification.
     * Resolves with `{ ok: boolean, code?: string }`.
     * Rejects with the underlying request error.
     *
     * This is where the magic happens - we talk to hcaptcha.com
     *
     * @param {string} token
     * @param {string} [remoteIp]
     * @param {string} [hostname]
     */
    verify(token, remoteIp, hostname) {
        return new Promise((resolve, reject) => {
            // Sanity check - token should be at least somewhat valid looking
            if (!token || typeof token !== "string" || token.length < 10) {
                return resolve({ ok: false, code: "invalid_token" });
            }

            // No secret? No verification. Simple as that.
            if (!this.secret) {
                return reject(new Error("missing_secret"));
            }

            const payload = new URLSearchParams({
                secret: this.secret,
                response: token,
            });
            if (remoteIp) payload.append("remoteip", remoteIp);

            const requestOptions = {
                hostname: "hcaptcha.com",
                port: 443,
                path: "/siteverify",
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Content-Length": Buffer.byteLength(payload.toString()),
                },
            };

            const req = https.request(requestOptions, (res) => {
                res.setEncoding("utf8");
                let body = "";

                res.on("data", (chunk) => (body += chunk));
                res.on("end", () => {
                    try {
                        const json = JSON.parse(body || "{}");
                        const ok = !!json.success;

                        // Check challenge timestamp - prevent replay attacks with old tokens
                        if (ok && json.challenge_ts) {
                            const challengeAge = (Date.now() - new Date(json.challenge_ts).getTime()) / 1000;
                            if (challengeAge > 5) {
                                // Token is too old (> 5 seconds) - probably a replay attack
                                this.logger && this.logger.warn && this.logger.warn(
                                    `[HCAPTCHA] ❌ Token expired: ${challengeAge.toFixed(1)}s old (max 5s)`
                                );
                                return resolve({ ok: false, code: "token_expired" });
                            }
                        }

                        // Verify hostname if we have an allowlist
                        if (ok && this.allowedHostnames.length) {
                            const responseHostname = json.hostname;
                            if (!responseHostname || !this.allowedHostnames.includes(responseHostname)) {
                                this.logger && this.logger.warn && this.logger.warn(
                                    `[HCAPTCHA] ❌ Hostname mismatch: ${responseHostname || "none"}`
                                );
                                return resolve({ ok: false, code: "hostname_mismatch" });
                            }
                        }

                        if (ok) {
                            return resolve({ ok: true });
                        }

                        // Extract error code from response
                        const code = Array.isArray(json["error-codes"]) && json["error-codes"][0]
                            ? json["error-codes"][0]
                            : "verification_failed";
                        resolve({ ok: false, code });
                    } catch (err) {
                        this.logger && this.logger.error && this.logger.error(`[HCAPTCHA] ❌ Parse error: ${err.message}`);
                        reject(err);
                    }
                });
            });

            req.on("error", (err) => {
                this.logger && this.logger.error && this.logger.error(`[HCAPTCHA] ❌ Request error: ${err.message}`);
                reject(err);
            });

            req.write(payload.toString());
            req.end();
        });
    }
}

module.exports = HCaptchaService;

