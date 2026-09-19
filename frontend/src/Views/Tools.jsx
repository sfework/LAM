import React from 'react';
import { withRouter, MergeSearch } from '@sfework/common';
import { Form, Tag } from '@douyinfe/semi-ui';
import { TablePage, SearchBox, DataTable } from '../Common/Component';
import Net from '../Common/Net';

/**
 * 工具库页（/api/tools，移植自参考实现前端的工具库页）：
 * 展示本服务 MCP 端点实际开放的只读工具清单（数据源 = src/mcp/tools.ts 的 TOOL_DEFS）。
 * 列 = 分组 + 名称 + 描述；搜索 = 关键字（名称/描述模糊）。工具集固定，无增删改。
 */

const groupColors = {
    '知识库': 'light-blue',
    'Agents': 'light-blue',
    '技能': 'light-blue',
    '记忆': 'light-green',
    '对话': 'light-green',
    '代码图': 'light-blue',
    'SQL': 'pink',
};

class Tools extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            loading: false,
            data: Net.GetPaginationModel(),
            search: Net.GetPaginationRequest(30),
        };
    }
    componentDidMount() { this.onLoad(); }
    onLoad = () => {
        this.setState({ loading: true });
        Net.api.tools.list(this.state.search).then(result => {
            if (result.success) this.setState({ data: result.data, loading: false });
            else this.setState({ loading: false });
        });
    };
    onSearch = (data) => {
        var search = MergeSearch(data, this.state.search);
        this.setState({ search }, () => this.onLoad());
    };
    columns = () => [
        {
            title: '分组', dataIndex: 'group', width: 100,
            render: (text) => <Tag color={groupColors[text] || 'grey'}>{text}</Tag>,
        },
        { title: '名称', dataIndex: 'name', width: 280, ellipsis: true },
        { title: '描述', dataIndex: 'description', ellipsis: true, render: (text) => text || '-' },
    ];
    render() {
        return <TablePage>
            <SearchBox onSearch={this.onSearch} initValues={this.state.search}>
                <Form.Input showClear field='keyword' label='关键字' style={{ width: 220 }} placeholder="名称或描述" />
                <SearchBox.Submit loading={this.state.loading} />
            </SearchBox>
            <DataTable onPagination={this.onSearch} loading={this.state.loading}
                rowKey='id' columns={this.columns()} dataSource={this.state.data} />
        </TablePage>;
    }
}

export default withRouter(Tools);
