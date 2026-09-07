-- Track how an OvertimeRequest was marked Work Completed: a matched
-- OVERTIME_IN/OVERTIME_OUT device punch pair ("DEVICE"), or an HR manual
-- override ("MANUAL", with an optional reason in completionNote).
ALTER TABLE "OvertimeRequest" ADD COLUMN "completionSource" TEXT;
ALTER TABLE "OvertimeRequest" ADD COLUMN "completionNote" TEXT;

-- Notification fired when a request flips to Work Completed (by device
-- match or HR override).
ALTER TYPE "NotificationType" ADD VALUE 'OVERTIME_WORK_COMPLETED';
