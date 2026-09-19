import React from 'react';
import { withRouter, MergeSearch } from '@sfework/common';
import { Button, Form, Typography, ButtonGroup } from '@douyinfe/semi-ui';
import { TablePage, SearchBox, DataTable, UIFormModal, ToastUI, DeleteConfirm } from '../Common/Component';
import Net from '../Common/Net';

/**
 * DB 备份页（/api/db，DESIGN §3、决策 52）：
 * VACUUM INTO 产出一致性快照到 {DATA_DIR}/backups/（不阻塞读写）；列表按时间倒序（新备份靠前）。
 * 点「立即备份」先弹确认窗（备份/恢复说明在窗内展示），确认后执行。
 * 恢复不做在线功能：停服后用选中备份覆盖 gateway.db 即可。
 */
function formatSize(bytes) {
    if (bytes == null) return '-';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let v = bytes / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(1)} ${units[i]}`;
}

function getTableColumns(view) {
    return [
        { title: '备份文件', dataIndex: 'name', ellipsis: true },
        { title: '大小', dataIndex: 'sizeBytes', width: 110, render: (text) => formatSize(text) },
        {
            title: '创建时间', dataIndex: 'createdAt', width: 200,
            render: (text) => text ? new Date(text).toLocaleString() : '-',
        },
        {
            title: '操作', dataIndex: 'operate', width: 90,
            render: (text, item) => (
                <ButtonGroup>
                    <DeleteConfirm onClick={() => view.delete(item.name)}>
                        <Button type="danger">删除</Button>
                    </DeleteConfirm>
                </ButtonGroup>
            ),
        },
    ];
}

class DbBackup extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            loading: false,
            data: Net.GetPaginationModel(),
            search: Net.GetPaginationRequest(30),
        };
        this.backupRef = React.createRef();
    }
    componentDidMount() { this.onLoad(); }
    onLoad = () => {
        this.setState({ loading: true });
        Net.api.db.list(this.state.search).then(result => {
            if (result.success) this.setState({ data: result.data, loading: false });
            else this.setState({ loading: false });
        });
    };
    onSearch = (data) => {
        var search = MergeSearch(data, this.state.search);
        this.setState({ search }, () => this.onLoad());
    };
    askBackup = () => this.backupRef.current.set(this.onLoad).show();
    delete = (name) => {
        Net.api.db.delete({ name }).then(result => {
            if (result.success) { ToastUI.success('删除成功'); this.onLoad(); }
        });
    };
    render() {
        return <TablePage>
            <SearchBox onSearch={this.onSearch} initValues={this.state.search}>
                <Form.Input showClear field='keyword' label='关键字' style={{ width: 220 }} placeholder="备份文件名" />
                <SearchBox.Submit />
                <SearchBox.Actions>
                    <Button theme='solid' type='primary' onClick={this.askBackup}>备份</Button>
                </SearchBox.Actions>
            </SearchBox>
            <DataTable onPagination={this.onSearch} loading={this.state.loading}
                columns={getTableColumns(this)} dataSource={this.state.data} />
            <BackupModal ref={this.backupRef} title='备份确认' width={520} />
        </TablePage>;
    }
}

/** 备份确认弹窗：展示备份/恢复说明，确认后调 /api/db/backup。 */
class BackupModal extends UIFormModal {
    set = (callback) => { this.callback = callback; return this; };
    onSubmit = async () => {
        const result = await Net.api.db.backup({});
        if (result.success) {
            ToastUI.success('备份完成');
            if (this.callback) this.callback();
            this.hide();
        }
    };
    children() {
        return <div style={{ color: 'var(--semi-color-text-2)', fontSize: 13, lineHeight: 1.8 }}>
            <div style={{ marginBottom: 8 }}>确认对当前数据库执行一次备份？</div>
            <div><Typography.Text strong>备份</Typography.Text>：每次备份生成独立的一致性快照（VACUUM INTO），存放于 {`{DATA_DIR}/backups/`}，不阻塞正常读写。</div>
            <div><Typography.Text strong>恢复</Typography.Text>：停止服务 → 将选中的备份文件重命名覆盖 {`{DATA_DIR}/gateway.db`}（同级的 gateway.db-wal / gateway.db-shm 一并删除）→ 重新启动服务。</div>
        </div>;
    }
}

export default withRouter(DbBackup);
