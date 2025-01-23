require('dotenv').config();
const { Client, GatewayIntentBits, Permissions } = require('discord.js');
const { ethers } = require('ethers');
const csvWriter = require('csv-writer').createObjectCsvWriter;
const path = require('path');
const fs = require('fs');

// Configuration
const CONFIG = {
    BOT: {
        TOKEN: process.env.DISCORD_TOKEN,
        ALLOWED_ROLES: process.env.ALLOWED_ROLES?.split(',') || ['admin', 'moderator'],
        TARGET_CHANNEL: process.env.TARGET_CHANNEL_ID
    },
    PERFORMANCE: {
        BATCH_SIZE: parseInt(process.env.BATCH_SIZE) || 100,
        MAX_MESSAGES: parseInt(process.env.MAX_MESSAGES) || 10000,
        DELAY_MS: parseInt(process.env.DELAY_BETWEEN_BATCHES) || 1000,
        MEMORY_THRESHOLD: parseFloat(process.env.MEMORY_THRESHOLD) || 0.8
    },
    OUTPUT: {
        DIR: process.env.OUTPUT_DIR || './output'
    }
};

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Utility functions
const utils = {
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    
    isValidEVMAddress: address => {
        try {
            return /^0x[a-fA-F0-9]{40}$/i.test(address) && ethers.utils.getAddress(address) !== null;
        } catch {
            return false;
        }
    },
    
    formatDate: date => {
        return date.toISOString().replace(/[:.]/g, '-').slice(0, -5);
    },
    
    checkMemory: () => {
        const memoryUsage = process.memoryUsage();
        if (memoryUsage.heapUsed / memoryUsage.heapTotal > CONFIG.PERFORMANCE.MEMORY_THRESHOLD) {
            console.log('Memory threshold reached, triggering GC');
            global.gc && global.gc();
        }
    }
};

// Date parser
class DateParser {
    static PRESETS = {
        'today': () => {
            const now = new Date();
            return {
                startDate: new Date(now.setHours(0, 0, 0, 0)),
                endDate: new Date(now.setHours(23, 59, 59, 999))
            };
        },
        'yesterday': () => {
            const now = new Date();
            now.setDate(now.getDate() - 1);
            return {
                startDate: new Date(now.setHours(0, 0, 0, 0)),
                endDate: new Date(now.setHours(23, 59, 59, 999))
            };
        },
        'week': () => {
            const now = new Date();
            const startDate = new Date(now);
            startDate.setDate(startDate.getDate() - 7);
            return { startDate, endDate: now };
        }
    };

    static parse(input) {
        if (this.PRESETS[input.toLowerCase()]) {
            return this.PRESETS[input.toLowerCase()]();
        }

        const dates = input.split('->').map(d => d.trim());
        const parseDate = (dateStr) => {
            const now = new Date();
            const parts = dateStr.split(' ');
            const dateParts = parts[0].split('-');
            
            if (dateParts.length === 2) {
                dateParts.unshift(now.getFullYear());
            }
            
            const date = new Date(dateParts.join('-'));
            
            if (parts[1]) {
                const [hours, minutes = '00'] = parts[1].split(':');
                date.setHours(parseInt(hours), parseInt(minutes));
            }
            
            return date;
        };

        const startDate = parseDate(dates[0]);
        const endDate = dates[1] ? parseDate(dates[1]) : new Date(startDate);
        endDate.setHours(23, 59, 59, 999);

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            throw new Error('Invalid date format');
        }

        return { startDate, endDate };
    }
}

// Message processor
class MessageProcessor {
    constructor() {
        this.addressMap = new Map();
        this.stats = {
            messagesProcessed: 0,
            addressesFound: 0,
            invalidAddresses: 0
        };
    }

    async processMessages(channel, startDate, endDate) {
        let lastMessageId = null;
        
        while (this.stats.messagesProcessed < CONFIG.PERFORMANCE.MAX_MESSAGES) {
            utils.checkMemory();

            const messages = await channel.messages.fetch({
                limit: CONFIG.PERFORMANCE.BATCH_SIZE,
                before: lastMessageId
            });

            if (messages.size === 0) break;

            for (const [_, message] of messages) {
                const messageDate = new Date(message.createdTimestamp);
                if (messageDate < startDate) break;
                if (messageDate > endDate) continue;

                this.processMessage(message);
            }

            lastMessageId = messages.last()?.id;
            messages.clear();
            await utils.sleep(CONFIG.PERFORMANCE.DELAY_MS);
        }

        return this.getResults();
    }

    processMessage(message) {
        this.stats.messagesProcessed++;
        const addresses = message.content.match(/0x[a-fA-F0-9]{40}/gi);
        
        if (!addresses) return;

        for (const address of addresses) {
            if (utils.isValidEVMAddress(address)) {
                this.addressMap.set(
                    `${message.author.id}_${address.toLowerCase()}`,
                    {
                        address: address.toLowerCase(),
                        timestamp: message.createdTimestamp,
                        author: message.author.tag
                    }
                );
                this.stats.addressesFound++;
            } else {
                this.stats.invalidAddresses++;
            }
        }
    }

    getResults() {
        return {
            addresses: Array.from(this.addressMap.values()),
            stats: this.stats
        };
    }
}

// CSV Handler
class CSVHandler {
    constructor(filePath) {
        this.writer = csvWriter({
            path: filePath,
            header: [
                { id: 'address', title: 'EVM Address' },
                { id: 'timestamp', title: 'Timestamp' },
                { id: 'author', title: 'Author' }
            ]
        });
    }

    async writeResults(results) {
        const CHUNK_SIZE = 1000;
        for (let i = 0; i < results.length; i += CHUNK_SIZE) {
            await this.writer.writeRecords(results.slice(i, i + CHUNK_SIZE));
        }
    }
}

// Command handler
async function handleExtractCommand(message, args) {
    try {
        // Permission check
        const member = await message.guild.members.fetch(message.author.id);
        const hasRole = member.roles.cache.some(role => 
            CONFIG.BOT.ALLOWED_ROLES.includes(role.name)
        );

        if (!hasRole) {
            return message.reply('You do not have permission to use this command.');
        }

        // Parse dates
        const dateArg = args.join(' ');
        const { startDate, endDate } = DateParser.parse(dateArg);

        // Create status message
        const statusMessage = await message.reply('Starting extraction process...');
        const startTime = process.hrtime.bigint();

        // Process messages
        const processor = new MessageProcessor();
        const { addresses, stats } = await processor.processMessages(
            message.channel,
            startDate,
            endDate
        );

        if (addresses.length === 0) {
            await statusMessage.edit('No addresses found in the specified time range.');
            return;
        }

        // Save results
        const fileName = `addresses_${utils.formatDate(startDate)}_to_${utils.formatDate(endDate)}.csv`;
        const filePath = path.join(CONFIG.OUTPUT.DIR, fileName);
        
        const csvHandler = new CSVHandler(filePath);
        await csvHandler.writeResults(addresses);

        // Calculate execution time
        const endTime = process.hrtime.bigint();
        const executionTime = Number(endTime - startTime) / 1e9;

        // Update status message
        await statusMessage.edit(
            `Extraction complete!\n` +
            `📊 Statistics:\n` +
            `- Messages processed: ${stats.messagesProcessed}\n` +
            `- Valid addresses found: ${stats.addressesFound}\n` +
            `- Invalid addresses found: ${stats.invalidAddresses}\n` +
            `- Execution time: ${executionTime.toFixed(2)}s\n` +
            `📁 Results saved to: ${fileName}`
        );

        // Send file to target channel if configured
        if (CONFIG.BOT.TARGET_CHANNEL) {
            const targetChannel = await client.channels.fetch(CONFIG.BOT.TARGET_CHANNEL);
            if (targetChannel) {
                const fileMessage = await targetChannel.send({
                    content: `EVM Address extraction results for ${dateArg}:`,
                    files: [filePath]
                });
                await fileMessage.pin();
            }
        }

    } catch (error) {
        console.error('Extraction error:', error);
        message.reply(`Error during extraction: ${error.message}`);
    }
}

// Event handlers
client.once('ready', () => {
    console.log(`Bot logged in as ${client.user.tag}`);
    
    // Create output directory if it doesn't exist
    if (!fs.existsSync(CONFIG.OUTPUT.DIR)) {
        fs.mkdirSync(CONFIG.OUTPUT.DIR, { recursive: true });
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const args = message.content.trim().split(/\s+/);
    const command = args.shift()?.toLowerCase();

    switch (command) {
        case '!extract':
            await handleExtractCommand(message, args);
            break;
            
        case '!help':
            message.reply(
                '**Available Commands:**\n' +
                '`!extract <date-range>` - Extract EVM addresses\n' +
                'Date range can be:\n' +
                '- "today", "yesterday", "week"\n' +
                '- "YYYY-MM-DD HH:MM -> YYYY-MM-DD HH:MM"\n' +
                '- "MM-DD HH:MM -> MM-DD HH:MM" (current year)\n' +
                '\n**Examples:**\n' +
                '`!extract today`\n' +
                '`!extract 2025-01-20 -> 2025-01-23`\n' +
                '`!extract 01-20 10:00 -> 01-23 15:30`'
            );
            break;
    }
});

// Error handler
client.on('error', error => {
    console.error('Discord client error:', error);
});

// Start the bot
client.login(CONFIG.BOT.TOKEN).catch(error => {
    console.error('Login error:', error);
    process.exit(1);
});