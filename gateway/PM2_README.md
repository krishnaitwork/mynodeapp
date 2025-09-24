# start using ecosystem file (run from gateway folder)
npx pm2 start ecosystem.config.cjs --env production --update-env

# persist the currently running list to dump file
npx pm2 save

# check status
npx pm2 ls

# view logs
npx pm2 logs gateway --lines 200

# restore saved processes (after reboot or if auto-start not installed)
npx pm2 resurrect

# (admin only) install PM2 startup service so saved list is auto-restored on boot
# run in elevated PowerShell
npx pm2 startup
# copy and run the printed command as Administrator, then:
npx pm2 save