require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const csvWriter = require('csv-writer').createObjectCsvWriter;
const schedule = require('node-schedule');

// Verify token is present
if (!process.env.DISCORD_TOKEN) {
    console.error('Error: DISCORD_TOKEN is not set in .env file');
    process.exit(1);
}

// Fetch extraction configuration from .env
const extractionChannelId = process.env.EXTRACTION_CHANNEL_ID;
const targetChannelId = process.env.TARGET_CHANNEL_ID;
const autoExtractStartTime = process.env.AUTO_EXTRACT_START_TIME || '00:00';
const autoExtractEndTime = process.env.AUTO_EXTRACT_END_TIME || '23:59';

// Validate environment variables
if (!extractionChannelId || !targetChannelId) {
    console.error('Error: Channel IDs are not set in the .env file.');
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
const ethAddressRegex = /\b0x[a-fA-F0-9]{40}\b/g;

// Function to get extraction start date based on configuration
function getExtractionStartDate() {
    const startDateConfig = process.env.AUTO_EXTRACT_START_DATE || 'prev-day';

    if (startDateConfig === 'prev-day') {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 1); // Go back one day
        startDate.setHours(0, 0, 0, 0); // Start at midnight
        return startDate;
    }

    if (startDateConfig === 'today') {
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Start at midnight
        return today;
    }

    // If a specific date is set, parse it
    try {
        const parsedDate = new Date(startDateConfig);
        if (isNaN(parsedDate.getTime())) {
            throw new Error(`Invalid AUTO_EXTRACT_START_DATE: ${startDateConfig}.`);
        }
        return parsedDate;
    } catch (error) {
        console.error('Invalid AUTO_EXTRACT_START_DATE. Defaulting to previous day.');
        const fallbackDate = new Date();
        fallbackDate.setDate(fallbackDate.getDate() - 1);
        fallbackDate.setHours(0, 0, 0, 0);
        return fallbackDate;
    }
}

// Function to get extraction end date based on configuration
function getExtractionEndDate() {
    const endDateConfig = process.env.AUTO_EXTRACT_END_DATE || 'today';

    if (endDateConfig === 'prev-day') {
        const endDate = new Date();
        endDate.setDate(endDate.getDate() - 1); // Go back one day
        endDate.setHours(23, 59, 59, 999); // End of previous day
        return endDate;
    }

    if (endDateConfig === 'today') {
        const today = new Date();
        today.setHours(23, 59, 59, 999); // End of today
        return today;
    }

    // If a specific date is set, parse it
    try {
        const parsedDate = new Date(endDateConfig);
        if (isNaN(parsedDate.getTime())) {
            throw new Error(`Invalid AUTO_EXTRACT_END_DATE: ${endDateConfig}.`);
        }
        parsedDate.setHours(23, 59, 59, 999); // Set to end of day
        return parsedDate;
    } catch (error) {
        console.error('Invalid AUTO_EXTRACT_END_DATE. Defaulting to today.');
        const fallbackDate = new Date();
        fallbackDate.setHours(23, 59, 59, 999);
        return fallbackDate;
    }
}

// Function to set start and end times
function setDateTime(date, timeString, isEndTime = false) {
    const [hours, minutes] = timeString.split(':').map(Number);
    
    if (isEndTime) {
        date.setHours(hours, minutes, 59, 999);
    } else {
        date.setHours(hours, minutes, 0, 0);
    }
    
    return date;
}

// Function to validate and parse date input with optional time
function parseDateInput(dateArg) {
    const currentYear = new Date().getFullYear();
    
    // Updated regex to support optional time
    const dateTimeRegex = /^(?:(\d{4})-)?(\d{2}-\d{2})(?:\s+(\d{2}):(\d{2}))?(?:,(?:(\d{4})-)?(\d{2}-\d{2})(?:\s+(\d{2}):(\d{2}))?)?$/;
    const dateRangeMatch = dateArg.match(dateTimeRegex);
    
    if (!dateRangeMatch) {
        throw new Error('Invalid date format. Use YYYY-MM-DD HH:MM or MM-DD HH:MM, or date ranges');
    }

    // Parse start date and time
    const startYear = dateRangeMatch[1] ? parseInt(dateRangeMatch[1]) : currentYear;
    const startDateStr = `${startYear}-${dateRangeMatch[2]}`;
    const startHours = dateRangeMatch[3] ? parseInt(dateRangeMatch[3]) : 0;
    const startMinutes = dateRangeMatch[4] ? parseInt(dateRangeMatch[4]) : 0;
    const startDate = new Date(startDateStr);
    startDate.setHours(startHours, startMinutes, 0, 0);

    // Parse end date and time (use start date/time if not specified)
    const endYear = dateRangeMatch[5] ? parseInt(dateRangeMatch[5]) : startYear;
    const endDateStr = dateRangeMatch[6] ? `${endYear}-${dateRangeMatch[6]}` : startDateStr;
    const endHours = dateRangeMatch[7] ? parseInt(dateRangeMatch[7]) : 23;
    const endMinutes = dateRangeMatch[8] ? parseInt(dateRangeMatch[8]) : 59;
    const endDate = new Date(endDateStr);
    endDate.setHours(endHours, endMinutes, 59, 999);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        throw new Error('Invalid date format. Use YYYY-MM-DD HH:MM or MM-DD HH:MM, or date ranges');
    }

    if (startDate > endDate) {
        [startDate, endDate] = [endDate, startDate];
    }

    return { startDate, endDate };
}

// Function to extract messages
async function extractMessages(channel, startDate, endDate, filePath) {
    const lastAddressPerUser = new Map();

    let lastMessageId = null;

    while (true) {
        const fetchedMessages = await channel.messages.fetch({
            limit: 100,
            before: lastMessageId,
        });

        if (fetchedMessages.size === 0) break;

        fetchedMessages.forEach(msg => {
            const msgDate = new Date(msg.createdTimestamp);

            if (msgDate >= startDate && msgDate <= endDate) {
                const addresses = msg.content.match(ethAddressRegex);

                if (addresses) {
                    for (let address of [...addresses].reverse()) {
                        if (!lastAddressPerUser.has(msg.author.id)) {
                            lastAddressPerUser.set(msg.author.id, address);
                            break;
                        }
                    }
                }
            }
        });

        lastMessageId = fetchedMessages.last()?.id;
    }

    const evmAddresses = Array.from(lastAddressPerUser.values());
    if (evmAddresses.length === 0) {
        console.log('No unique EVM addresses found for the specified range.');
        return false;
    }

    const csvWriterInstance = csvWriter({
        path: filePath,
        header: [{ id: 'address', title: 'EVM Address' }],
    });

    await csvWriterInstance.writeRecords(evmAddresses.map(addr => ({ address: addr })));
    console.log(`CSV file created: ${filePath}`);
    return true;
}

// Manual extraction command
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.content.startsWith('!extract')) {
        const member = await message.guild.members.fetch(message.author.id);
        const hasRole = member.roles.cache.some(role => allowedRoles.includes(role.name));

        if (!hasRole) {
            return message.reply('You do not have permission to use this command.');
        }

        const args = message.content.split(' ');
        if (args.length < 2) {
            return message.reply('Usage: `!extract YYYY-MM-DD [HH:MM]` or `!extract MM-DD [HH:MM]` or date ranges');
        }

try {
    // Reconstruct the date argument (in case it was split)
    const dateArg = args.slice(1).join(' ');
    const { startDate, endDate } = parseDateInput(dateArg);
    const extractionChannel = message.channel; // The channel where the command was issued
    const targetChannelId = process.env.TARGET_CHANNEL_ID; // Fetch from .env
    if (!targetChannelId) {
        message.reply('Error: Target channel is not defined in the .env file.');
        return;
    }

    const targetChannel = await client.channels.fetch(targetChannelId).catch(() => null);
    if (!targetChannel) {
        message.reply(`Error: Could not fetch the target channel with ID ${targetChannelId}.`);
        return;
    }

    // Add this line to define filePath
    const filePath = `./${dateArg.replace(/\s+/g, '_').replace(',', '_to_')}.csv`;

    const success = await extractMessages(extractionChannel, startDate, endDate, filePath);

			if (success) {
				const sentMessage = await targetChannel.send({
					content: `Here are the extracted addresses for ${dateArg}:`,
					files: [filePath],
				});
				await sentMessage.pin();
				message.reply(`The extracted addresses have been sent to <#${targetChannelId}>.`);
			} else {
				message.reply('No addresses were found in the specified date range.');
			}                       
        } catch (error) {
            message.reply(error.message);
        }
    }
});

// Get schedule time from .env, default to daily at midnight
const autoExtractScheduleTime = process.env.AUTO_EXTRACT_SCHEDULE_TIME || '0 0 * * *';

// Scheduled extraction
schedule.scheduleJob(autoExtractScheduleTime, async () => {
    console.log('Running automated extraction...');
    try {
        const targetChannel = await client.channels.fetch(targetChannelId);
        const extractionChannel = await client.channels.fetch(extractionChannelId);

        if (!targetChannel || !extractionChannel) {
            console.error('One or both channels not found. Check the channel IDs in the .env file.');
            return;
        }

        // Get extraction dates
        const startDate = getExtractionStartDate();
        const endDate = getExtractionEndDate();

        // Override with specific times if provided in .env
        setDateTime(startDate, autoExtractStartTime);
        setDateTime(endDate, autoExtractEndTime, true);

        // Ensure start date is before end date
        if (startDate > endDate) {
            [startDate, endDate] = [endDate, startDate];
        }

        // Generate CSV file path
        const filePath = `./autoextract_${startDate.toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 16)}_to_${endDate.toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 16)}.csv`;

        // Perform message extraction
        const success = await extractMessages(extractionChannel, startDate, endDate, filePath);

        if (success) {
            const sentMessage = await targetChannel.send({
                content: `Here is the automated extraction from **${startDate.toISOString().split('T')[0]}** to **${endDate.toISOString().split('T')[0]}**.`,
                files: [filePath],
            });
            await sentMessage.pin();
            console.log('File sent and message pinned successfully.');
        } else {
            console.log('No addresses found for the specified date range.');
        }
    } catch (error) {
        console.error('Error during scheduled extraction:', error);
    }
});

// Log in the bot
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

client.login(process.env.DISCORD_TOKEN);