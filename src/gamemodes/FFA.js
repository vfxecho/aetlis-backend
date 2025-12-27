var Mode = require('./Mode');
var Logger = require('../modules/Logger');

function FFA() {
    Mode.apply(this, Array.prototype.slice.call(arguments));

    this.ID = 0;
    this.name = "Free For All";
    this.specByLeaderboard = true;
}

module.exports = FFA;
FFA.prototype = new Mode();

// Helper: clamp position to border with given radius
FFA.prototype._clampToBorder = function (border, pos, radius) {
    return {
        x: Math.max(border.minx + radius, Math.min(border.maxx - radius, pos.x)),
        y: Math.max(border.miny + radius, Math.min(border.maxy - radius, pos.y))
    };
};

// Helper: ensure distance >= minDistance
FFA.prototype._distance = function (a, b) {
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
};

// Helper: find safe spawn spot near a target position with radius clearance
FFA.prototype.findEmptySpotNear = function (gameServer, targetPos, spawnSize, minDistance) {
    var border = gameServer.border;
    var attempts = 256;
    var goldenAngle = Math.PI * (3 - Math.sqrt(5)); // spiral
    var ringSpacing = Math.max(spawnSize * 0.9, 120);
    var bestCandidate = null;
    var bestDistance = Infinity;

    // Logger.debug('[FFA-FINE] findEmptySpotNear target=(' + Math.floor(targetPos.x) + ',' + Math.floor(targetPos.y) + ') minDist=' + minDistance);

    for (var attempt = 0; attempt < attempts; attempt++) {
        var ring = Math.floor(attempt / 12);
        var radius = minDistance + ring * ringSpacing;
        var angle = attempt * goldenAngle;
        var candidate = {
            x: targetPos.x + Math.cos(angle) * radius,
            y: targetPos.y + Math.sin(angle) * radius
        };

        candidate = this._clampToBorder(border, candidate, spawnSize);

        // Skip if still too close to target (just in case)
        if (this._distance(candidate, targetPos) < minDistance * 0.85) {
            continue;
        }

        if (!gameServer.willCollide(candidate, spawnSize)) {
            Logger.debug('[FFA-SPAWN] ✅ Empty spot found after ' + (attempt + 1) + ' attempts at (' + Math.floor(candidate.x) + ',' + Math.floor(candidate.y) + ')');
            return candidate;
        }

        // Track closest fallback candidate (even if colliding) to stay near partner
        if (radius < bestDistance) {
            bestCandidate = candidate;
            bestDistance = radius;
        }
    }

    Logger.warn('[FFA-SPAWN] ⚠️ Could not find completely empty spot near partner after ' + attempts + ' attempts, using closest candidate at (' + (bestCandidate ? Math.floor(bestCandidate.x) + ',' + Math.floor(bestCandidate.y) : 'null') + ').');
    return bestCandidate || targetPos;
};

// Helper: keep begging for a safe spawn without yeeting outside the intended radius
// IMPORTANT: For dual/partner spawns, we FORCE spawn near partner even if collision exists
// The game's normal physics will push the cells apart safely
FFA.prototype._begForSafeSpawnSpot = function (gameServer, anchorProvider, spawnSize, minDistance, label) {
    var self = this;
    var lastGoodPosition = null; // Track the last position we attempted

    return {
        lockSpawnPosition: true,
        maxCollisionRetries: 40,
        forceNearSpawn: true, // NEW: Force spawn at this position even if collision exists
        resolveCollision: function (meta) {
            var anchorPos = anchorProvider ? anchorProvider() : null;
            if (!anchorPos) {
                Logger.warn('[FFA-SPAWN] resolveCollision(' + label + ') - anchorPos is NULL');
                return null;
            }
            // USE AUTHORITATIVE SIZE FROM GAMESERVER (meta.size) for collision checks
            // This prevents mismatch between FFA calculation and GameServer's actual spawn size
            var checkSize = (meta && meta.size) ? meta.size : spawnSize;

            var candidate = self.findEmptySpotNear(gameServer, anchorPos, checkSize, minDistance);
            if (candidate) {
                lastGoodPosition = candidate;
            }
            return candidate;
        },
        onCollisionFail: function (meta) {
            var pid = (meta && meta.player) ? meta.player.pID : '?';

            // INSTEAD OF RETURNING NULL (which triggers random spawn),
            // return the last attempted position - we'll force spawn there!
            // The game's collision resolution will push cells apart safely.
            var anchorPos = anchorProvider ? anchorProvider() : null;

            if (anchorPos) {
                // Calculate a position adjacent to partner (minDistance away)
                var forcePos = {
                    x: anchorPos.x + minDistance,
                    y: anchorPos.y
                };
                // Clamp to border
                var border = gameServer.border;
                forcePos.x = Math.max(border.minx + spawnSize, Math.min(border.maxx - spawnSize, forcePos.x));
                forcePos.y = Math.max(border.miny + spawnSize, Math.min(border.maxy - spawnSize, forcePos.y));

                Logger.info('[FFA-SPAWN] ⚡ ' + (label || 'locked') + ' spawn FORCING position after ' +
                    (meta ? meta.attempts : 0) + ' retries for PID=' + pid +
                    '. Forcing spawn at (' + Math.floor(forcePos.x) + ',' + Math.floor(forcePos.y) +
                    ') near partner. Physics will resolve collision.');
                return forcePos;
            }

            // Absolute fallback: use last good position or meta.lastPosition
            if (lastGoodPosition) {
                Logger.info('[FFA-SPAWN] ⚡ Using last good position for forced spawn: (' +
                    Math.floor(lastGoodPosition.x) + ',' + Math.floor(lastGoodPosition.y) + ')');
                return lastGoodPosition;
            }

            if (meta && meta.lastPosition) {
                Logger.info('[FFA-SPAWN] ⚡ Using meta.lastPosition for forced spawn: (' +
                    Math.floor(meta.lastPosition.x) + ',' + Math.floor(meta.lastPosition.y) + ')');
                return meta.lastPosition;
            }

            Logger.warn('[FFA-SPAWN] ❌ ' + (label || 'locked') + ' spawn BAILED - no position available');
            return null;
        }
    };
};


// Gamemode-specific functions

FFA.prototype.onPlayerSpawn = function (gameServer, player) {
    // ========================================
    // COMPREHENSIVE NEAR-DEATH RESPAWN LOGGING
    // For debugging why main player spawns far but dual spawns near
    // ========================================

    var border = gameServer.border;
    var tm = gameServer.tournamentManager;
    var isTournamentMode = tm && tm.isActive;
    var playerType = player.playerType || 'MAIN';
    var isDual = playerType === 'DUAL_MINION';
    var ownerPlayer = player.ownerPlayer;

    Logger.info('\n' + '='.repeat(80));
    Logger.info('[NEAR-SPAWN-DEBUG] 🎯 FFA.onPlayerSpawn START');
    Logger.info('='.repeat(80));

    // === PLAYER IDENTITY ===
    Logger.info('[NEAR-SPAWN-DEBUG] PLAYER INFO:');
    Logger.info('  - PID: ' + player.pID);
    Logger.info('  - Name: "' + player._name + '"');
    Logger.info('  - PlayerType: ' + playerType);
    Logger.info('  - IsDual: ' + isDual);
    Logger.info('  - OwnerPID: ' + (ownerPlayer ? ownerPlayer.pID : 'N/A'));
    Logger.info('  - DiscordId: ' + (player.discordId || 'N/A'));
    Logger.info('  - IsBot: ' + (player.isBot || (player.socket && player.socket.isBot) || false));
    Logger.info('  - CurrentCells: ' + player.cells.length);
    Logger.info('  - LastSpawnContext: ' + (player.lastSpawnContext || 'manual'));

    // === TOURNAMENT STATE ===
    Logger.info('[NEAR-SPAWN-DEBUG] TOURNAMENT STATE:');
    Logger.info('  - TournamentActive: ' + isTournamentMode);
    if (isTournamentMode) {
        Logger.info('  - RoundStarted: ' + tm.roundStarted);
        Logger.info('  - IsFrozen: ' + tm.isFrozen);
        Logger.info('  - IsPaused: ' + (tm.isPaused || false));
        Logger.info('  - NearDeathRespawnEnabled: ' + (tm.nearDeathRespawnEnabled !== false));
    }

    // === BORDER STATE (CRITICAL FOR SHRINKING MAP) ===
    Logger.info('[NEAR-SPAWN-DEBUG] BORDER STATE:');
    Logger.info('  - Border.minx: ' + Math.floor(border.minx));
    Logger.info('  - Border.maxx: ' + Math.floor(border.maxx));
    Logger.info('  - Border.miny: ' + Math.floor(border.miny));
    Logger.info('  - Border.maxy: ' + Math.floor(border.maxy));
    Logger.info('  - Border.width: ' + Math.floor(border.width));
    Logger.info('  - Border.height: ' + Math.floor(border.height));
    if (gameServer.config.worldIsCircular) {
        Logger.info('  - WorldRadius: ' + gameServer.config.worldRadius);
    }

    // === DEATH POSITION STATE ===
    Logger.info('[NEAR-SPAWN-DEBUG] DEATH POSITION STATE:');
    Logger.info('  - lastDeathPosition: ' + (player.lastDeathPosition ?
        '(' + Math.floor(player.lastDeathPosition.x) + ', ' + Math.floor(player.lastDeathPosition.y) + ')' : 'NULL'));
    Logger.info('  - shouldUseNearDeathSpawn: ' + player.shouldUseNearDeathSpawn);

    // Check if death position is INSIDE current border
    if (player.lastDeathPosition) {
        var deathInBounds = (
            player.lastDeathPosition.x >= border.minx &&
            player.lastDeathPosition.x <= border.maxx &&
            player.lastDeathPosition.y >= border.miny &&
            player.lastDeathPosition.y <= border.maxy
        );
        Logger.info('  - DeathPosInsideBorder: ' + deathInBounds);
        if (!deathInBounds) {
            Logger.warn('  - ⚠️ WARNING: Death position is OUTSIDE current border! Map may have shrunk.');
            Logger.warn('  - DeathPos.x vs border: ' + Math.floor(player.lastDeathPosition.x) +
                ' vs [' + Math.floor(border.minx) + ', ' + Math.floor(border.maxx) + ']');
            Logger.warn('  - DeathPos.y vs border: ' + Math.floor(player.lastDeathPosition.y) +
                ' vs [' + Math.floor(border.miny) + ', ' + Math.floor(border.maxy) + ']');
        }
    }

    // === DUAL/PARTNER STATE ===
    Logger.info('[NEAR-SPAWN-DEBUG] PARTNER STATE:');
    if (isDual && ownerPlayer) {
        Logger.info('  - OwnerHasCells: ' + (ownerPlayer.cells.length > 0));
        Logger.info('  - OwnerCellCount: ' + ownerPlayer.cells.length);
        if (ownerPlayer.cells.length > 0) {
            var ownerBiggest = ownerPlayer.cells.reduce(function (prev, curr) {
                return (prev && prev._size > curr._size) ? prev : curr;
            }, ownerPlayer.cells[0]);
            Logger.info('  - OwnerBiggestCellPos: (' + Math.floor(ownerBiggest.position.x) + ', ' + Math.floor(ownerBiggest.position.y) + ')');
            Logger.info('  - OwnerBiggestCellSize: ' + Math.floor(ownerBiggest._size));
        }
    } else if (player.dualPlayer) {
        Logger.info('  - DualHasCells: ' + (player.dualPlayer.cells.length > 0));
        Logger.info('  - DualCellCount: ' + player.dualPlayer.cells.length);
        if (player.dualPlayer.cells.length > 0) {
            var dualBiggest = player.dualPlayer.cells.reduce(function (prev, curr) {
                return (prev && prev._size > curr._size) ? prev : curr;
            }, player.dualPlayer.cells[0]);
            Logger.info('  - DualBiggestCellPos: (' + Math.floor(dualBiggest.position.x) + ', ' + Math.floor(dualBiggest.position.y) + ')');
            Logger.info('  - DualBiggestCellSize: ' + Math.floor(dualBiggest._size));
        }
    } else {
        Logger.info('  - NoPartnerAvailable');
    }

    // === TEAM SIZE CHECK (TOURNAMENT) ===
    if (tm && tm.isActive && tm.teamSizeLimit > 0) {
        var isDualSpawn = player.playerType === 'DUAL_MINION';
        var checkDiscordId = isDualSpawn && player.ownerPlayer ? player.ownerPlayer.discordId : player.discordId;

        if (checkDiscordId) {
            var spawnError = tm.canPlayerSpawn(player, isDualSpawn);
            if (spawnError) {
                Logger.warn('[NEAR-SPAWN-DEBUG] ❌ Spawn BLOCKED: ' + spawnError + ' for PID=' + player.pID);
                return;
            }
        }
    }

    player.setColor(gameServer.getSpawnColorForPlayer(player));

    // === SPAWN POSITION CALCULATION ===
    var spawnPos = null;
    var spawnOptions = null;
    var usedNearDeath = false;
    var spawnDecision = 'UNKNOWN';

    var isBot = (player.socket && player.socket.isBot) || player.isBot;
    var tournamentRandomSpawn = tm && tm.isActive && tm.roundStarted && !tm.isFrozen && !tm.nearDeathRespawnEnabled;

    Logger.info('[NEAR-SPAWN-DEBUG] SPAWN DECISION FACTORS:');
    Logger.info('  - isBot: ' + isBot);
    Logger.info('  - tournamentRandomSpawn: ' + tournamentRandomSpawn);
    Logger.info('  - nearDeathRespawnEnabled: ' + (tm ? tm.nearDeathRespawnEnabled : 'N/A'));

    if (isBot) {
        spawnPos = gameServer.randomPos();
        spawnDecision = 'BOT_RANDOM';
        Logger.info('[NEAR-SPAWN-DEBUG] 🤖 Decision: BOT_RANDOM spawn');
    } else if (tournamentRandomSpawn) {
        spawnPos = gameServer.randomPos();
        spawnDecision = 'TOURNAMENT_RANDOM_FORCED';
        Logger.info('[NEAR-SPAWN-DEBUG] 🎮 Decision: TOURNAMENT_RANDOM_FORCED (nearDeathRespawnEnabled=false)');
    } else {
        var spawnContext = player.lastSpawnContext || 'manual';
        var allowPartnerSpawn = (
            spawnContext === 'auto' ||
            spawnContext === 'auto_forced' ||
            spawnContext === 'auto_dual' ||
            spawnContext === 'dual_create' ||
            spawnContext === 'manual_dual' ||
            spawnContext === 'switch_dual' ||
            spawnContext === 'switch_main'
        );

        Logger.info('[NEAR-SPAWN-DEBUG] CONTEXT CHECK:');
        Logger.info('  - spawnContext: ' + spawnContext);
        Logger.info('  - allowPartnerSpawn: ' + allowPartnerSpawn);

        var dualPartner = null;
        if (allowPartnerSpawn && player.dualPlayer && player.dualPlayer.cells.length > 0) {
            dualPartner = player.dualPlayer;
            Logger.info('[NEAR-SPAWN-DEBUG] 👥 Found partner: DUAL (PID=' + dualPartner.pID + ')');
        } else if (allowPartnerSpawn && player.ownerPlayer && player.playerType === 'DUAL_MINION' && player.ownerPlayer.cells.length > 0) {
            dualPartner = player.ownerPlayer;
            Logger.info('[NEAR-SPAWN-DEBUG] 👥 Found partner: OWNER (PID=' + dualPartner.pID + ')');
        } else {
            Logger.info('[NEAR-SPAWN-DEBUG] 👥 No partner spawn available');
            Logger.info('  - Reason: allowPartnerSpawn=' + allowPartnerSpawn +
                ', hasDual=' + !!player.dualPlayer +
                ', dualCells=' + (player.dualPlayer ? player.dualPlayer.cells.length : 0) +
                ', hasOwner=' + !!player.ownerPlayer +
                ', ownerCells=' + (player.ownerPlayer ? player.ownerPlayer.cells.length : 0));
        }

        if (dualPartner && dualPartner.cells.length > 0) {
            spawnDecision = 'NEAR_PARTNER';

            var partnerCell = dualPartner.cells.reduce(function (prev, curr) {
                return (prev && prev._size > curr._size) ? prev : curr;
            }, dualPartner.cells[0]);

            var partnerMouse = dualPartner.mouse || partnerCell.position;
            var dirX = partnerMouse.x - partnerCell.position.x;
            var dirY = partnerMouse.y - partnerCell.position.y;
            var length = Math.sqrt(dirX * dirX + dirY * dirY);
            if (length < 1) { dirX = 1; dirY = 0; } else { dirX /= length; dirY /= length; }

            var spawnSize = gameServer.config.playerStartSize || 32;
            if (tm && tm.isActive && !tm.isFrozen && tm.roundStarted && !isBot && !player.isMi && player.lastSpawnName &&
                gameServer.config.playerAfterDeathSize && gameServer.config.playerAfterDeathSize > 0) {
                spawnSize = gameServer.config.playerAfterDeathSize;
            }

            var minDistance = partnerCell._size + spawnSize + 64;
            var anchorProvider = function () {
                if (!dualPartner || dualPartner.cells.length === 0) return null;
                return dualPartner.cells.reduce(function (prev, curr) {
                    return (prev && prev._size > curr._size) ? prev : curr;
                }, dualPartner.cells[0]).position;
            };
            var anchorPos = anchorProvider() || partnerCell.position;

            Logger.info('[NEAR-SPAWN-DEBUG] 👥 NEAR_PARTNER spawn calculation:');
            Logger.info('  - PartnerCellPos: (' + Math.floor(partnerCell.position.x) + ', ' + Math.floor(partnerCell.position.y) + ')');
            Logger.info('  - PartnerCellSize: ' + Math.floor(partnerCell._size));
            Logger.info('  - AnchorPos: (' + Math.floor(anchorPos.x) + ', ' + Math.floor(anchorPos.y) + ')');
            Logger.info('  - SpawnSize: ' + spawnSize);
            Logger.info('  - MinDistance: ' + minDistance);

            spawnPos = this.findEmptySpotNear(gameServer, anchorPos, spawnSize, minDistance);
            spawnOptions = this._begForSafeSpawnSpot(gameServer, anchorProvider, spawnSize, minDistance, 'dual');

            if (spawnPos) {
                var distFromPartner = Math.sqrt(
                    Math.pow(spawnPos.x - anchorPos.x, 2) +
                    Math.pow(spawnPos.y - anchorPos.y, 2)
                );
                Logger.info('  - SpawnPosFound: (' + Math.floor(spawnPos.x) + ', ' + Math.floor(spawnPos.y) + ')');
                Logger.info('  - DistanceFromPartner: ' + Math.floor(distFromPartner));
            } else {
                Logger.warn('  - ⚠️ findEmptySpotNear returned NULL for partner spawn');
            }

        } else if (player.lastDeathPosition && player.shouldUseNearDeathSpawn) {
            spawnDecision = 'NEAR_DEATH';

            var rx = (Math.random() * 300) - 150;
            var ry = (Math.random() * 300) - 150;
            var originalDeathPos = { x: player.lastDeathPosition.x, y: player.lastDeathPosition.y };
            var deathPos = {
                x: player.lastDeathPosition.x + rx,
                y: player.lastDeathPosition.y + ry
            };

            // Check if death position needs clamping
            var needsClampX = deathPos.x < border.minx || deathPos.x > border.maxx;
            var needsClampY = deathPos.y < border.miny || deathPos.y > border.maxy;

            deathPos.x = Math.max(border.minx, Math.min(deathPos.x, border.maxx));
            deathPos.y = Math.max(border.miny, Math.min(deathPos.y, border.maxy));

            var spawnSize = gameServer.config.playerStartSize || 32;
            if (tm && tm.isActive && !tm.isFrozen && tm.roundStarted && !isBot && !player.isMi && player.lastSpawnName &&
                gameServer.config.playerAfterDeathSize && gameServer.config.playerAfterDeathSize > 0) {
                spawnSize = gameServer.config.playerAfterDeathSize;
            }

            var nearDeathMinDistance = Math.max(spawnSize * 2, 200);
            var deathAnchorProvider = function () { return deathPos; };

            Logger.info('[NEAR-SPAWN-DEBUG] 💀 NEAR_DEATH spawn calculation:');
            Logger.info('  - OriginalDeathPos: (' + Math.floor(originalDeathPos.x) + ', ' + Math.floor(originalDeathPos.y) + ')');
            Logger.info('  - RandomOffset: (' + Math.floor(rx) + ', ' + Math.floor(ry) + ')');
            Logger.info('  - TargetDeathPos: (' + Math.floor(deathPos.x) + ', ' + Math.floor(deathPos.y) + ')');
            Logger.info('  - NeedsClampX: ' + needsClampX + ', NeedsClampY: ' + needsClampY);
            if (needsClampX || needsClampY) {
                Logger.warn('  - ⚠️ Death position was CLAMPED to border bounds!');
                Logger.warn('    This may cause spawn to be far from original death location');
            }
            Logger.info('  - SpawnSize: ' + spawnSize);
            Logger.info('  - MinDistance: ' + nearDeathMinDistance);

            spawnPos = this.findEmptySpotNear(gameServer, deathPos, spawnSize, nearDeathMinDistance);
            spawnOptions = this._begForSafeSpawnSpot(gameServer, deathAnchorProvider, spawnSize, nearDeathMinDistance, 'near-death');
            usedNearDeath = true;

            if (spawnPos) {
                var distFromDeath = Math.sqrt(
                    Math.pow(spawnPos.x - originalDeathPos.x, 2) +
                    Math.pow(spawnPos.y - originalDeathPos.y, 2)
                );
                Logger.info('  - SpawnPosFound: (' + Math.floor(spawnPos.x) + ', ' + Math.floor(spawnPos.y) + ')');
                Logger.info('  - DistanceFromOriginalDeath: ' + Math.floor(distFromDeath));
                if (distFromDeath > 1000) {
                    Logger.warn('  - ⚠️ Spawn is FAR (>' + Math.floor(distFromDeath) + ') from death! Possible issue.');
                }
            } else {
                Logger.warn('  - ⚠️ findEmptySpotNear returned NULL for near-death spawn');
            }
        } else {
            // === WHY NOT USING NEAR-DEATH SPAWN ===
            spawnDecision = 'RANDOM_FALLBACK';
            Logger.info('[NEAR-SPAWN-DEBUG] ❓ NOT using near-death/partner spawn. Reasons:');
            Logger.info('  - hasLastDeathPosition: ' + !!player.lastDeathPosition);
            Logger.info('  - shouldUseNearDeathSpawn: ' + player.shouldUseNearDeathSpawn);
            Logger.info('  - cells.length: ' + player.cells.length);
            Logger.info('  - allowPartnerSpawn: ' + allowPartnerSpawn);
            Logger.info('  - hasDualPartner: ' + !!dualPartner);

            if (!player.lastDeathPosition) {
                Logger.info('  - ⚠️ No death position recorded! Player may have just connected.');
            }
            if (!player.shouldUseNearDeathSpawn) {
                Logger.info('  - ⚠️ shouldUseNearDeathSpawn=false. Was player alive when respawn triggered?');
                Logger.info('    (This flag is set to TRUE only when cells.length=0 in joinGame())');
            }
        }
    }

    // === FALLBACK TO RANDOM ===
    if (!spawnPos) {
        spawnPos = gameServer.randomPos();
        if (spawnDecision !== 'BOT_RANDOM' && spawnDecision !== 'TOURNAMENT_RANDOM_FORCED') {
            spawnDecision = 'RANDOM_FALLBACK';
        }
        Logger.info('[NEAR-SPAWN-DEBUG] 🎲 Using RANDOM spawn (fallback). Pos: (' + Math.floor(spawnPos.x) + ', ' + Math.floor(spawnPos.y) + ')');
    }

    // === FINAL SPAWN ===
    Logger.info('[NEAR-SPAWN-DEBUG] FINAL SPAWN:');
    Logger.info('  - Decision: ' + spawnDecision);
    Logger.info('  - TargetPos: (' + Math.floor(spawnPos.x) + ', ' + Math.floor(spawnPos.y) + ')');
    Logger.info('  - HasSpawnOptions: ' + !!spawnOptions);

    gameServer.spawnPlayer(player, spawnPos, spawnOptions);

    // === POST-SPAWN VERIFICATION ===
    if (player.cells.length > 0) {
        var actualCell = player.cells[0];
        var actualPos = actualCell.position;
        var distFromTarget = Math.sqrt(
            Math.pow(actualPos.x - spawnPos.x, 2) +
            Math.pow(actualPos.y - spawnPos.y, 2)
        );

        Logger.info('[NEAR-SPAWN-DEBUG] POST-SPAWN CHECK:');
        Logger.info('  - ActualCellPos: (' + Math.floor(actualPos.x) + ', ' + Math.floor(actualPos.y) + ')');
        Logger.info('  - DistFromTarget: ' + Math.floor(distFromTarget));

        if (distFromTarget > 500) {
            Logger.warn('  - ⚠️ Actual spawn position differs from target by ' + Math.floor(distFromTarget) + '!');
            Logger.warn('    This indicates collision resolution moved the spawn point.');
        }

        // Compare to death/partner position if applicable
        if (usedNearDeath && player.lastDeathPosition) {
            var distFromDeath = Math.sqrt(
                Math.pow(actualPos.x - player.lastDeathPosition.x, 2) +
                Math.pow(actualPos.y - player.lastDeathPosition.y, 2)
            );
            Logger.info('  - ActualDistFromDeath: ' + Math.floor(distFromDeath));
            if (distFromDeath > 1500) {
                Logger.warn('  - ⚠️ SPAWN IS FAR FROM DEATH! Check border shrink or collision.');
            }
        }
    } else {
        Logger.warn('[NEAR-SPAWN-DEBUG] ⚠️ Player has NO CELLS after spawn! Spawn may have been blocked.');
    }

    Logger.info('='.repeat(80));
    Logger.info('[NEAR-SPAWN-DEBUG] END');
    Logger.info('='.repeat(80) + '\n');
};

FFA.prototype.updateLB = function (gameServer) {
    gameServer.leaderboardType = this.packetLB;

    // OgarX-master sorting logic: cleaner and more efficient
    var lb = gameServer.clients
        .map(function (c) { return c.playerTracker; })
        .filter(function (p) {
            // Skip bots from leaderboard
            if (p && p.socket && p.socket.isBot) return false;
            if (p && p.isBot) return false;
            return p && !p.isRemoved && p.cells.length > 0;
        })
        .sort(function (a, b) { return b._score - a._score; });

    gameServer.leaderboard = lb;
    this.rankOne = lb[0];
    gameServer.leaderboardChanged = true;
};
