import React from 'react';
import { withRouter } from '@sfework/common';
import { Button, Table, Tag, Switch, InputNumber, Input, ButtonGroup, Select, Typography } from '@douyinfe/semi-ui';
import { TablePage, ContentPage, ToastUI } from '../Common/Component';
import Net from '../Common/Net';

/**
 * 设置页（/api/settings，DESIGN §2.10）：按注册表元数据自动渲染控件——
 *   int/float → InputNumber；bool → Switch；string → Input；modelRef → 模型下拉（按分类取 /api/models）。
 * 修改后点「保存」调 /api/settings/set（字符串值，服务端按类型校验），热更新即时生效。
 */
class Settings extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            loading: true,
            items: [],
            models: { llm: [], embedding: [] },
            edits: {},   // key -> 新值（未保存）
            saving: {},  // key -> 保存中
        };
    }
    componentDidMount() { this.onLoad(); }
    onLoad = () => {
        this.setState({ loading: true });
        Promise.all([
            Net.api.settings.list({ page: 1, pageSize: 1000 }),
            Net.api.models.list({ category: 'llm', page: 1, pageSize: 1000 }),
            Net.api.models.list({ category: 'embedding', page: 1, pageSize: 1000 }),
        ]).then(([s, llm, emb]) => {
            if (!s.success) { this.setState({ loading: false }); return; }
            this.setState({
                loading: false,
                items: s.data.list,
                models: {
                    llm: llm.success ? llm.data.list : [],
                    embedding: emb.success ? emb.data.list : [],
                },
                edits: {},
            });
        });
    };
    valueOf = (item) => item.key in this.state.edits ? this.state.edits[item.key] : item.effective;
    onChange = (key, v) => this.setState(st => ({ edits: { ...st.edits, [key]: v } }));
    save = (item) => {
        const v = this.valueOf(item);
        this.setState(st => ({ saving: { ...st.saving, [item.key]: true } }));
        Net.api.settings.set({ key: item.key, value: String(v) }).then(result => {
            this.setState(st => ({ saving: { ...st.saving, [item.key]: false } }));
            if (result.success) {
                ToastUI.success(`${item.key} 已保存（热更新生效）`);
                this.onLoad();
            }
        });
    };
    reset = (item) => this.setState(st => {
        const e = { ...st.edits };
        delete e[item.key];
        return { edits: e };
    });
    renderValue = (item) => {
        const v = this.valueOf(item);
        switch (item.type) {
            case 'bool':
                return <Switch checked={!!v} onChange={(c) => this.onChange(item.key, c)} />;
            case 'int':
            case 'float':
                return <InputNumber step={item.type == 'int' ? 1 : 0.01} value={v} min={item.min} max={item.max}
                    precision={item.type === 'int' ? 0 : undefined}
                    style={{ width: 180 }} onChange={(n) => this.onChange(item.key, n)} />;
            case 'modelRef': {
                const opts = (this.state.models[item.modelCategory] || [])
                    .map(m => ({ label: `${m.name}（${m.model}）`, value: m.id }));
                return <Select value={v || ''} optionList={opts} style={{ width: 350 }}
                    placeholder="未绑定" showClear onChange={(val) => this.onChange(item.key, val ?? '')} />;
            }
            default:
                return <Input value={v} style={{ width: 260 }} onChange={(val) => this.onChange(item.key, val)} />;
        }
    };
    render() {
        const columns = [
            {
                title: '设置项', dataIndex: 'key', width: 350,
                render: (text, item) => <div>
                    <Typography.Text>{item.description}</Typography.Text>
                    <div><Typography.Text type='tertiary' size='small'>{text}</Typography.Text></div>
                </div>,
            },
            {
                title: '类型', dataIndex: 'type', width: 90,
                render: (text) => <Tag size='small' color='grey'>{text}</Tag>,
            },
            { title: '默认值', dataIndex: 'defaultValue', width: 120, ellipsis: true },
            { title: '当前值', dataIndex: 'effective', render: (t, item) => this.renderValue(item) },
            {
                title: '操作', dataIndex: 'operate', width: 138,
                render: (t, item) => {
                    const dirty = item.key in this.state.edits && this.valueOf(item) !== item.effective;
                    return <ButtonGroup>
                        <Button theme='solid' type='primary' disabled={!dirty}
                            loading={!!this.state.saving[item.key]} onClick={() => this.save(item)}>保存</Button>
                        <Button disabled={!dirty} onClick={() => this.reset(item)}>还原</Button>
                    </ButtonGroup>;
                },
            },
        ];
        return <ContentPage loading={this.state.loading} style={{ flex: 1, width: '100%', overflow: 'auto', display: this.state.loading ? 'flex' : 'block' }}>
            {!this.state.loading && <Table size='small' rowKey='key' columns={columns} dataSource={this.state.items}
                pagination={false} scroll={{ x: 1000 }} />}
        </ContentPage>;
    }
}

export default withRouter(Settings);
