import React from 'react';
import { withRouter } from '@sfework/common';
import { Button, Form, Typography, Spin } from '@douyinfe/semi-ui';
import { IconFile, IconDelete } from '@douyinfe/semi-icons';
import { TablePage, SearchBox, UIModal, ToastUI, DeleteConfirm, ContentPage } from '../Common/Component';
import Net from '../Common/Net';

/**
 * 日志页（/api/logs，DESIGN §5 日志方案、决策 53）：
 * 日志按 {DATA_DIR}/Logs/{yyyy}/{MM}/{dd}/{HH}.txt 每小时一个文件。
 * 筛选区 = 日期选择（默认当天）；下方仿 Windows 资源管理器（中等图标）的平铺网格：
 * 图标 + 文件名，浅背景、悬停加重，点击弹窗只读查看内容，悬停右上角出现删除按钮（IO 删文件）。
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

/** Date → 'yyyy-MM-dd'（本地时区）。 */
function toDateStr(d) {
    const x = d instanceof Date ? d : new Date(d);
    const MM = String(x.getMonth() + 1).padStart(2, '0');
    const dd = String(x.getDate()).padStart(2, '0');
    return `${x.getFullYear()}-${MM}-${dd}`;
}

class Logs extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            loading: false,
            dateStr: toDateStr(new Date()),
            files: [],
            viewTitle: '日志',
        };
        this.viewRef = React.createRef();
    }
    componentDidMount() { this.onLoad(); }
    onLoad = () => {
        this.setState({ loading: true });
        Net.api.logs.list({ date: this.state.dateStr }).then(result => {
            if (result.success) this.setState({ files: result.data.files, loading: false });
            else this.setState({ files: [], loading: false });
        });
    };
    onSearch = (data) => {
        const dateStr = data.date ? toDateStr(data.date) : toDateStr(new Date());
        this.setState({ dateStr }, () => this.onLoad());
    };
    view = (file) => () => {
        this.setState({ viewTitle: `${this.state.dateStr} ${file.hour}:00 日志` },
            () => this.viewRef.current.open(this.state.dateStr, file));
    };
    delete = (file) => () => {
        Net.api.logs.delete({ date: this.state.dateStr, name: file.name }).then(result => {
            if (result.success) { ToastUI.success('删除成功'); this.onLoad(); }
        });
    };
    render() {
        const { files, loading, dateStr } = this.state;
        return <TablePage>
            <SearchBox onSearch={this.onSearch} initValues={{ date: new Date() }}>
                <Form.DatePicker field='date' label='日期' type='date' showClear={false}
                    style={{ width: 180 }} format='yyyy-MM-dd' />
                <SearchBox.Submit loading={loading} />
            </SearchBox>
            {/* TablePage 为 column flex + align-items:flex-start，须显式撑满宽度，网格才能随窗口增列 */}
            <ContentPage loading={loading} style={{ flex: 1, width: '100%', overflow: 'auto' ,padding:0}}>
                <div className='logGrid'>
                    {files.map(f => (
                        <div key={f.name} className='logTile'
                            title={`${f.name}\n大小：${formatSize(f.sizeBytes)}\n修改：${new Date(f.modifiedAt).toLocaleString()}`}
                            onClick={this.view(f)}>
                            <IconFile size='extra-large' className='logTileIcon' />
                            <div className='logTileName'>{f.name}</div>
                            <span className='logTileDelete' onClick={e => e.stopPropagation()}>
                                <DeleteConfirm onClick={this.delete(f)}>
                                    <Button size='small' theme='borderless' type='danger' icon={<IconDelete />} />
                                </DeleteConfirm>
                            </span>
                        </div>
                    ))}
                </div>
                {!loading && files.length === 0 && (
                    <Typography.Text type='tertiary'>该日期暂无日志文件</Typography.Text>
                )}
            </ContentPage>
            <ViewModal ref={this.viewRef} height={520} width={860} footer='hideOk' title={this.state.viewTitle} />
        </TablePage>;
    }
}

/** 日志查看弹窗：只读 pre 展示，不可编辑；仅「关闭」按钮。 */
class ViewModal extends UIModal {
    constructor(props) {
        super(props);
        this.state = { ...this.state, content: '', loading: false };
    }
    open = (dateStr, file) => {
        this.dateStr = dateStr;
        this.file = file;
        this.setState({ content: '', loading: true });
        this.show();
    };
    onShow = () => {
        Net.api.logs.get({ date: this.dateStr, name: this.file.name }).then(result => {
            if (result.success) this.setState({ content: result.data.content, loading: false });
            else this.setState({ loading: false });
        });
    };
    children() {
        if (this.state.loading) return <div style={{ textAlign: 'center', padding: 40 }}><Spin size='large' /></div>;
        return <pre style={{
            margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            fontFamily: 'var(--semi-font-family-code, Consolas, monospace)', fontSize: 12, lineHeight: 1.6,
        }}>{this.state.content || '（空文件）'}</pre>;
    }
}

export default withRouter(Logs);
