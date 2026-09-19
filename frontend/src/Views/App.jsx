import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { Layout, Breadcrumb, Nav } from '@douyinfe/semi-ui';
import { useMenuHelp } from '../Common/Common';
import { MenuItems } from '../Common/MenuItems';

/**
 * 应用外壳：左侧 Nav + 右侧面包屑/内容区（参考项目同款布局）。
 * 菜单/路由/面包屑全部由 MenuItems 单一数据源驱动（useMenuHelp）。
 * 本项目无鉴权、无用户体系，故不含 UserTag / 登录。
 */
function App() {
    var menu = useMenuHelp(MenuItems);
    return <div className='BodyPage'>
        <Routes>
            <Route path="/*" element={<>
                <Layout.Sider>
                    <Nav {...menu.navProps} />
                </Layout.Sider>
                <Layout.Content className="Content">
                    <Layout.Header className='ContentHeader'>
                        <Breadcrumb>
                            {menu.breadcrumbs.map((item, index) => <Breadcrumb.Item key={index}>{item}</Breadcrumb.Item>)}
                        </Breadcrumb>
                    </Layout.Header>
                    <Layout.Content className='ContentBody'>
                        <Routes>
                            {menu.routeConfigs.map(c => <Route key={c.key} path={c.path} element={c.element} />)}
                        </Routes>
                    </Layout.Content>
                </Layout.Content>
            </>} />
        </Routes>
    </div>;
}

export default App;
