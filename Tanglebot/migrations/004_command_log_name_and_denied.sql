-- discord_name: the name to show next to discord_id, as it was when the command ran. Rows from
-- before this migration have none.
alter table command_log add column discord_name text;

-- status 'denied': the person did not have the role for the command.
alter table command_log drop constraint command_log_status_check;
alter table command_log add constraint command_log_status_check check (status in ('ok', 'error', 'denied'));
