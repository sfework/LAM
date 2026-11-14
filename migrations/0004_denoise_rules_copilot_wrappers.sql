-- Copilot/VS Code 每轮包装噪声（召回质量审计结论 2026-11-07）：
-- current_datetime / ide_selection / tagged_files / system_notification 全通道删除；
-- system_reminder 仅 memory 通道删除（apply_forward=0）——保留转发侧 workspace_info 等环境提醒，
-- 召回查询词改按 memory 通道除噪（见 gateway/index.ts 步骤 5.5），两者配合生效。
--> statement-breakpoint
INSERT INTO denoise_rules (id, start_text, end_text, extract, apply_forward, apply_memory, enabled, created_at, updated_at) VALUES
 ('dr_9c1f0a2b3c4d5e01', '<current_datetime>',    '</current_datetime>',    0, 1, 1, 1, 1794052800000, 1794052800000),
 ('dr_9c1f0a2b3c4d5e02', '<system_reminder>',     '</system_reminder>',     0, 0, 1, 1, 1794052800001, 1794052800001),
 ('dr_9c1f0a2b3c4d5e03', '<ide_selection>',       '</ide_selection>',       0, 1, 1, 1, 1794052800002, 1794052800002),
 ('dr_9c1f0a2b3c4d5e04', '<tagged_files>',        '</tagged_files>',        0, 1, 1, 1, 1794052800003, 1794052800003),
 ('dr_9c1f0a2b3c4d5e05', '<system_notification>', '</system_notification>', 0, 1, 1, 1, 1794052800004, 1794052800004);
