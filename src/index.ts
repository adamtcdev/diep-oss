/*
    DiepCustom - custom tank game server that shares diep.io's WebSocket protocol
    Copyright (C) 2022 ABCxFF (github.com/ABCxFF)

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published
    by the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program. If not, see <https://www.gnu.org/licenses/>
*/

import * as fs from "fs";
import { ServerWebSocket } from "bun";
import Client, { ClientWrapper } from "./Client";
import * as config from "./config"
import * as util from "./util";
import GameServer from "./Game";
import TankDefinitions from "./Const/TankDefinitions";
import { commandDefinitions } from "./Const/Commands";
import { ColorsHexCode } from "./Const/Enums";

import FFAArena from "./Gamemodes/FFA";
import SandboxArena from "./Gamemodes/Sandbox";

const PORT = config.serverPort;
const ENABLE_API = config.enableApi && config.apiLocation;
const ENABLE_CLIENT = config.enableClient && config.clientLocation && fs.existsSync(config.clientLocation);

if (ENABLE_API) util.log(`Rest API hosting is enabled and is now being hosted at /${config.apiLocation}`);
if (ENABLE_CLIENT) util.log(`Client hosting is enabled and is now being hosted from ${config.clientLocation}`);

export const bannedClients = new Set<string>();
const connections = new Map<string, number>();
const allClients = new Set<Client>();
const games: GameServer[] = [];

// Initialize games
const ffa = new GameServer(FFAArena, "FFA");
const sbx = new GameServer(SandboxArena, "Sandbox");
games.push(ffa, sbx);

Bun.serve<ClientWrapper>({
    port: PORT,
    fetch(req, server) {
        const url = new URL(req.url);

        // WebSocket Upgrade
        if (server.upgrade(req, {
            data: {
                client: null,
                ipAddress: server.requestIP(req)?.address || "unknown",
                gamemode: url.pathname.slice(1)
            }
        })) {
            return;
        }

        util.saveToVLog("Incoming request to " + url.pathname);

        // API Handling
        if (ENABLE_API && url.pathname.startsWith(`/${config.apiLocation}`)) {
            const apiPath = url.pathname.slice(config.apiLocation.length + 1);
            switch (apiPath) {
                case "/":
                    return new Response(null, { status: 200 });
                case "/tanks":
                    return new Response(JSON.stringify(TankDefinitions));
                case "/servers":
                    return new Response(JSON.stringify(games.map(({ gamemode, name }) => ({ gamemode, name }))));
                case "/commands":
                    return new Response(JSON.stringify(config.enableCommands ? Object.values(commandDefinitions) : []));
                case "/colors":
                    return new Response(JSON.stringify(ColorsHexCode));
            }
        }

        // Client File Serving
        if (ENABLE_CLIENT) {
            let file: string | null = null;
            let contentType = "text/html";

            switch (url.pathname) {
                case "/":
                    file = config.clientLocation + "/index.html";
                    contentType = "text/html";
                    break;
                case "/loader.js":
                    file = config.clientLocation + "/loader.js";
                    contentType = "application/javascript";
                    break;
                case "/input.js":
                    file = config.clientLocation + "/input.js";
                    contentType = "application/javascript";
                    break;
                case "/dma.js":
                    file = config.clientLocation + "/dma.js";
                    contentType = "application/javascript";
                    break;
                case "/config.js":
                    file = config.clientLocation + "/config.js";
                    contentType = "application/javascript";
                    break;
            }

            if (file && fs.existsSync(file)) {
                return new Response(Bun.file(file), {
                    headers: { "Content-Type": contentType + "; charset=utf-8" }
                });
            }

            return new Response(Bun.file(config.clientLocation + "/404.html"), { status: 404 });
        }

        return new Response("Not Found", { status: 404 });
    },
    websocket: {
        maxPayloadLength: config.wssMaxMessageSize,
        idleTimeout: 10,
        open(ws) {
            const ipAddress = ws.data.ipAddress;
            let conns = 0;
            if (connections.has(ipAddress)) conns = connections.get(ipAddress) as number;

            if (conns >= config.connectionsPerIp || bannedClients.has(ipAddress)) {
                ws.close();
                return;
            }

            connections.set(ipAddress, conns + 1);

            const game = games.find(({ gamemode }) => gamemode === ws.data.gamemode);
            if (!game) {
                ws.close();
                return;
            }

            const client = new Client(ws, game);
            allClients.add(client);
            ws.data.client = client;
        },
        message(ws, message) {
            const { client } = ws.data;
            if (!client) throw new Error("Non-existent client for websocket");

            // Bun passes message as string | Buffer / Uint8Array. 
            // Client.onMessage expects ArrayBuffer and boolean for isBinary.
            // But checking Client.ts logic: "if (!isBinary) return this.terminate();"
            // So we only really care about binary messages in current logic.

            if (typeof message === "string") {
                // The original logic calls terminate() if !isBinary.
                // We can simulate this:
                client.onMessage(new ArrayBuffer(0), false);
            } else {
                // message is Buffer (Uint8Array)
                client.onMessage(message.buffer as ArrayBuffer, true);
            }
        },
        close(ws, code, message) {
            const { client, ipAddress } = ws.data;
            if (client) {
                connections.set(ipAddress, (connections.get(ipAddress) as number) - 1);
                // Bun message is string, Client expects ArrayBuffer? 
                // Client.onClose signature: (code: number, message: ArrayBuffer)
                // Let's pass a dummy buffer if message is string, or convert it.
                // Usually message is not critical for logic here.
                const msgBuffer = typeof message === 'string' ? new TextEncoder().encode(message).buffer : new ArrayBuffer(0);

                client.onClose(code, msgBuffer);
                allClients.delete(client);
            }
        }
    }
});

util.log(`Listening on port ${PORT}`);

util.saveToLog("Servers up", "All servers booted up.", 0x37F554);
util.log("Dumping endpoint -> gamemode routing table");
for (const game of games) console.log("> " + `localhost:${config.serverPort}/${game.gamemode}`.padEnd(40, " ") + " -> " + game.name);

process.on("uncaughtException", (error) => {
    util.saveToLog("Uncaught Exception", '```\n' + error.stack + '\n```', 0xFF0000);
    throw error;
});
