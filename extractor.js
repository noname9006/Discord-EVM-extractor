require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const csvWriter = require('csv-writer').createObjectCsvWriter;

// Verify token is present
if (!process.env.DISCORD_TOKEN) {
    console.error('Error: DISCORD_TOKEN is not set in .env file');
    process.exit(1);
}

// Initialize the bot
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// Allowed role names
const allowedRoles = ['the creator', 'Botanix Team', 'Lead Spider'];

// Regex for Ethereum addresses
const ethAddressRegex = /0x[a-fA-F0-9]{40}/g;

// Function to validate and parse date
function parseDateInput(dateArg) {
    // Check if input is a single date or a range
    const currentYear = new Date().getFullYear();
    
    // Regex to match full YYYY-MM-DD or MM-DD for current year
    const dateRangeMatch = dateArg.match(/^(?:(\d{4})-)?(\d{2}-\d{2})(?:,(?:(\d{4})-)?(\d{2}-\d{2}))?$/);
    
    if (!dateRangeMatch) {
        throw new Error('Invalid date format. Use YYYY-MM-DD, MM-DD, or date ranges with optional year');
    }

    // Determine start date
    const startYear = dateRangeMatch[1] ? parseInt(dateRangeMatch[1]) : currentYear;
    const startDateStr = `${startYear}-${dateRangeMatch[2]}`;
    const startDate = new Date(startDateStr);

    // Determine end date (use start date's year if not specified)
    const endYear = dateRangeMatch[3] ? parseInt(dateRangeMatch[3]) : 
                    dateRangeMatch[4] ? startYear : startYear;
    const endDateStr = dateRangeMatch[4] ? 
        `${endYear}-${dateRangeMatch[4]}` : 
        `${endYear}-${dateRangeMatch[2]}`;
    const endDate = new Date(endDateStr);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        throw new Error('Invalid date format. Use YYYY-MM-DD, MM-DD, or date ranges with optional year');
    }

    // Ensure correct date order
    if (startDate > endDate) {
        [startDate, endDate] = [endDate, startDate];
    }

    return { startDate, endDate };
}

// Log in the bot
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

client.on('messageCreate', async (message) => {
    // Ignore messages from bots
    if (message.author.bot) return;

    // Check if the message starts with the bot command
    if (message.content.startsWith('!extract')) {
        // Check if the user has one of the allowed roles
        const member = await message.guild.members.fetch(message.author.id);
        const hasRole = member.roles.cache.some(role => allowedRoles.includes(role.name));

        if (!hasRole) {
            return message.reply('You do not have permission to use this command.');
        }

        // Extract parameters from the command
        const args = message.content.split(' ');
        if (args.length < 2) {
            return message.reply('Usage: `!extract YYYY-MM-DD` or `!extract YYYY-MM-DD,YYYY-MM-DD` or `!extract MM-DD` or `!extract MM-DD,MM-DD`');
        }
        
        try {
            const { startDate, endDate } = parseDateInput(args[1]);

            const channel = message.channel;
            const userAddresses = new Map(); // Map to store last address for each user
            const uniqueAddresses = new Set(); // Set to track unique addresses across all users
            let lastMessageId = null;

            // Fetch messages in chunks
            while (true) {
                const fetchedMessages = await channel.messages.fetch({
                    limit: 100,
                    before: lastMessageId,
                });

                if (fetchedMessages.size === 0) break;

                fetchedMessages.forEach(msg => {
                    const msgDate = new Date(msg.createdTimestamp);
                    
                    // Check if message is within the date range
                    if (msgDate >= startDate && msgDate <= new Date(endDate.getTime() + 86400000)) { // Add full day
                        // Find all addresses in the message
                        const addresses = msg.content.match(ethAddressRegex);
                        
                        // If addresses found, update the last address for this user
                        if (addresses) {
                            // Reverse to get the last address first
                            for (let address of [...addresses].reverse()) {
                                // Only keep if address hasn't been seen before
                                if (!uniqueAddresses.has(address)) {
                                    userAddresses.set(msg.author.id, address);
                                    uniqueAddresses.add(address);
                                    break; // Stop after finding first unique address
                                }
                            }
                        }
                    }
                });

                lastMessageId = fetchedMessages.last()?.id;
            }

            // Convert Map to array of addresses
            const evmAddresses = Array.from(userAddresses.values());

            if (evmAddresses.length === 0) {
                return message.reply('No unique EVM addresses found for the specified date range.');
            }

            // Write to CSV
            const filePath = `./${args[1].replace(',', '_to_')}.csv`;
            const csvWriterInstance = csvWriter({
                path: filePath,
                header: [{ id: 'address', title: 'EVM Address' }],
            });

            await csvWriterInstance.writeRecords(evmAddresses.map(addr => ({ address: addr })));

            // Reply with the CSV file and pin the message
            const replyMessage = await message.reply({
                content: `${args[1]} Here are the extracted unique EVM addresses:`,
                files: [filePath],
            });

            // Pin the reply message
            try {
                await replyMessage.pin();
            } catch (error) {
                console.error('Failed to pin the message:', error);
            }
        } catch (error) {
            message.reply(error.message);
        }
    }
});

// Login the bot
client.login(process.env.DISCORD_TOKEN);