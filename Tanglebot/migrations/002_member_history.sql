-- Display order of the pet catalog (the Pets sheet tab's row order).
-- (This file once also created member_names and member_stays. Their history now lives in
-- member_events, created in 005, so fresh installs never create them; see 006 and DATABASE.md.)
alter table pets add column sort_order integer not null default 0;
