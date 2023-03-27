# DDatDocker
Docker版的各个DDatHome  
安装Docker：https://docs.docker.com/engine/install/  

#### 安装完后docker的小记：  
1. 安装完后来这里跟着继续配置一下docker权限和开机启动docker：https://docs.docker.com/engine/install/linux-postinstall/
##### 这里我来做一个文档简短的总结和翻译：
```bash

# 让你省去每次都打sudo来运行docker的麻烦
sudo groupadd docker
sudo usermod -aG docker $USER
newgrp docker

# 验证下能否不用sudo就用docker成功
docker run hello-world

# 开启docker开机启动
sudo systemctl enable docker.service
sudo systemctl enable containerd.service
```

2. 推荐给docker设置一下log最大限制防止硬盘被log吃光（我被这么教训过）  
linux去修改`/etc/docker/daemon.json`成如下
```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3" 
  }
}
```
默认没有这个文件，去创建一个保存  
最后别忘记`sudo systemctl restart docker`才能生效  
也有很多官方推荐的其他log解决办法，不过这个`daemon.json`修改比较一劳永逸  
其他方法：https://docs.docker.com/config/containers/logging/json-file/


### NodeJs版Docker
Node版源码：https://github.com/dd-center/DDatHome-nodejs  
Docker Hub: https://hub.docker.com/r/simon300000/ddathome-nodejs  

#### Pull下载
```sh
sudo docker pull simon300000/ddathome-nodejs
```
#### 临时运行
```shell
sudo docker run simon300000/ddathome-nodejs
```
#### 长期后台运行
```shell
sudo docker run -d -e NICKNAME=你想要的昵称 --restart=always simon300000/ddathome-nodejs
```

### Go版Docker
Go版源码：https://github.com/dd-center/DDatHome-go  
Docker Hub: https://hub.docker.com/r/imlonghao/ddathome-go  
#### Pull下载
```
sudo docker pull imlonghao/ddathome-go
```
#### 临时运行
```
sudo docker run imlonghao/ddathome-go
```
#### 长期后台运行
```
sudo docker run -d --restart=always imlonghao/ddathome-go
```
