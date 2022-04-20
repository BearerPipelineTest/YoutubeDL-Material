const utils = require('./utils');
const db_api = require('./db');

const fs = require('fs-extra');
const logger = require('./logger');
const scheduler = require('node-schedule');

const TASKS = {
    backup_local_db: {
        run: utils.backupLocalDB,
        title: 'Backup Local DB',
        job: null
    },
    missing_files_check: {
        run: checkForMissingFiles,
        confirm: deleteMissingFiles,
        title: 'Missing files check',
        job: null
    },
    missing_db_records: {
        run: db_api.importUnregisteredFiles,
        title: 'Import missing DB records',
        job: null
    },
    duplicate_files_check: {
        run: checkForDuplicateFiles,
        confirm: removeDuplicates,
        title: 'Find duplicate files in DB',
        job: null
    }
}

function scheduleJob(task_key, schedule) {
    return scheduler.scheduleJob(schedule, async () => {
        const task_state = await db_api.getRecord('tasks', {key: task_key});
        if (task_state['running'] || task_state['confirming']) {
            logger.verbose(`Skipping running task ${task_state['key']} as it is already in progress.`);
            return;
        }
        
        // we're just "running" the task, any confirmation should be user-initiated
        exports.executeRun(task_key);
    });
}

exports.initialize = async () => {
    const tasks_keys = Object.keys(TASKS);
    for (let i = 0; i < tasks_keys.length; i++) {
        const task_key = tasks_keys[i];
        const task_in_db = await db_api.getRecord('tasks', {key: task_key});
        if (!task_in_db) {
            // insert task into table if missing
            await db_api.insertRecordIntoTable('tasks', {
                key: task_key,
                last_ran: null,
                last_confirmed: null,
                running: false,
                confirming: false,
                data: null,
                error: null,
                schedule: null
            });
        } else {
            // reset task if necessary
            await db_api.updateRecord('tasks', {key: task_key}, {running: false, confirming: false});

            // schedule task and save job
            if (task_in_db['schedule']) {
                TASKS[task_key]['job'] = scheduleJob(task_key, task_in_db['schedule']);
            }
        }
    }
}

exports.executeTask = async (task_key) => {
    if (!TASKS[task_key]) {
        logger.error(`Task ${task_key} does not exist!`);
        return;
    }
    logger.verbose(`Executing task ${task_key}`);
    await exports.executeRun(task_key);
    if (!TASKS[task_key]['confirm']) return;
    await exports.executeConfirm(task_key);
    logger.verbose(`Finished executing ${task_key}`);
}

exports.executeRun = async (task_key) => {
    await db_api.updateRecord('tasks', {key: task_key}, {running: true});
    const data = await TASKS[task_key].run();
    await db_api.updateRecord('tasks', {key: task_key}, {data: data, last_ran: Date.now()/1000, running: false});
}

exports.executeConfirm = async (task_key) => {
    if (!TASKS[task_key]['confirm']) {
        return null;
    }
    await db_api.updateRecord('tasks', {key: task_key}, {confirming: true});
    const task_obj = await db_api.getRecord('tasks', {key: task_key});
    const data = task_obj['data'];
    await TASKS[task_key].confirm(data);
    await db_api.updateRecord('tasks', {key: task_key}, {confirming: false, last_confirmed: Date.now()/1000});
}

exports.updateTaskSchedule = async (task_key, schedule) => {
    await db_api.updateRecord('tasks', {key: task_key}, {schedule: schedule});
    if (TASKS[task_key]['job']) {
        TASKS[task_key]['job'].cancel();
    }
    if (schedule) {
        TASKS[task_key]['job'] = scheduleJob(task_key, schedule);
    }
}

// missing files check

async function checkForMissingFiles() {
    const missing_files = [];
    const all_files = await db_api.getRecords('files');
    for (let i = 0; i < all_files.length; i++) {
        const file_to_check = all_files[i];
        const file_exists = fs.existsSync(file_to_check['path']);
        if (!file_exists) missing_files.push(file_to_check['uid']);
    }
    return {uids: missing_files};
}

async function deleteMissingFiles(data) {
    const uids = data['uids'];
    for (let i = 0; i < uids.length; i++) {
        const uid = uids[i];
        await db_api.removeRecord('files', {uid: uid});
    }
}

// duplicate files check

async function checkForDuplicateFiles() {
    const duplicate_files = await db_api.findDuplicatesByKey('files', 'path');
    const duplicate_uids = duplicate_files.map(duplicate_file => duplicate_file['uid']);
    if (duplicate_uids && duplicate_uids.length > 0) {
        return {uids: duplicate_uids};
    }
    return {uids: []};
}

async function removeDuplicates(data) {
    for (let i = 0; i < data['uids'].length; i++) {
        await db_api.removeRecord('files', {uid: data['uids'][i]});
    }
}

exports.TASKS = TASKS;